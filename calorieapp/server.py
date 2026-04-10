import os
import math
import json
import tempfile
import uuid
from datetime import datetime, timedelta
from typing import Optional

import numpy as np
import requests
from flask import Flask, render_template, request, redirect, url_for, flash, Response, jsonify
from flask_login import LoginManager, login_user, logout_user, login_required, current_user
from flask_migrate import Migrate
from dotenv import load_dotenv
from openai import OpenAI
from sklearn.metrics.pairwise import cosine_similarity
import chromadb
from chromadb.config import Settings

from calorie_counter import get_calories_from_image
from models import db, User, Profile, MealLog, KnowledgeBase, DocumentEmbedding, RAGChatHistory, DailyTargets, DailyProgress, FoodItem, Nutrients, CalorieDetectionLog, WorkoutSession, WorkoutSet, Device, HeartRateLog, SpO2Log, MotionLog, HealthAlert

load_dotenv()
openai_client = OpenAI()
USDA_API_KEY = os.getenv("USDA_API_KEY")
EXERCISEDB_API_KEY = os.getenv("EXERCISEDB_API_KEY")
EXERCISEDB_HOST = os.getenv("EXERCISEDB_HOST")
EXERCISEDB_BASE_URL = (os.getenv("EXERCISEDB_BASE_URL") or "").rstrip("/")

app = Flask(__name__)
app.config["SECRET_KEY"] = os.getenv("SECRET_KEY", "change-this-secret")
app.config["SQLALCHEMY_DATABASE_URI"] = os.getenv("DATABASE_URL", "sqlite:///calorieapp.db")
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False

db.init_app(app)
migrate = Migrate(app, db)

login_manager = LoginManager(app)
login_manager.login_view = "login"

@login_manager.user_loader
def load_user(user_id):
    return User.query.get(int(user_id))

def calculate_bmr_tdee(profile: Profile):
    if not profile or not all([
        profile.weight_kg,
        profile.height_cm,
        profile.age,
        profile.sex,
        profile.activity_level,
    ]):
        return {"bmr": None, "tdee": None}

    w = profile.weight_kg
    h = profile.height_cm
    a = profile.age
    sex = profile.sex.lower()

    if sex == "male":
        bmr = 10 * w + 6.25 * h - 5 * a + 5
    else:
        bmr = 10 * w + 6.25 * h - 5 * a - 161

    activity_map = {
        "sedentary": 1.2,
        "light": 1.375,
        "moderate": 1.55,
        "active": 1.725,
        "athlete": 1.9,
    }
    tdee = bmr * activity_map.get(profile.activity_level, 1.2)
    return {"bmr": round(bmr), "tdee": round(tdee)}

# ===== YOLO realtime (lazy-loaded) =====
_yolo_model = None
def get_yolo_model():
    global _yolo_model
    if _yolo_model is None:
        try:
            from ultralytics import YOLO
            # Prefer a lightweight default; ultralytics will auto-download on first use
            _yolo_model = YOLO(os.getenv("YOLO_MODEL", "yolov8n.pt"))
        except Exception as e:
            _yolo_model = e  # stash the error to surface later
    return _yolo_model

@app.route("/")
def index():
    if current_user.is_authenticated:
        return redirect(url_for("dashboard"))
    return redirect(url_for("login"))

@app.route("/start", methods=["GET", "POST"])
def start():
    if request.method == "POST":
        # Create user
        name = request.form.get("name", "").strip()
        email = request.form.get("email", "").strip().lower()
        password = request.form.get("password", "")
        height_cm = request.form.get("height_cm")
        weight_kg = request.form.get("weight_kg")
        age = request.form.get("age")
        sex = request.form.get("sex")
        activity = request.form.get("activity_level")

        if not email or not password:
            flash("Email and password are required", "error")
            return redirect(url_for("start"))

        existing = User.query.filter_by(email=email).first()
        if existing:
            flash("Email already registered", "error")
            return redirect(url_for("start"))

        user = User(email=email)
        user.set_password(password)
        db.session.add(user)
        db.session.commit()

        prof = Profile(
            user_id=user.id,
            name=name if name else None,
            height_cm=float(height_cm) if height_cm else None,
            weight_kg=float(weight_kg) if weight_kg else None,
            age=int(age) if age else None,
            sex=sex,
            activity_level=activity,
            unit_system="metric",
        )
        db.session.add(prof)
        db.session.commit()
        login_user(user)
        return redirect(url_for("dashboard"))

    return render_template("start.html")

@app.route("/calories")
@login_required
def calories_page():
    return render_template("calories_professional.html")

@app.route("/upload", methods=["POST"])
@login_required
def upload():
    image = request.files.get("image")
    if not image or image.filename == "":
        return {"error": "No image uploaded"}, 400

    temp_file = tempfile.NamedTemporaryFile()
    image.save(temp_file.name)
    calories = get_calories_from_image(temp_file.name)
    temp_file.close()

    if current_user.is_authenticated:
        try:
            # Extract nutrition data
            total_cals = 0
            protein = 0
            fat = 0
            carbs = 0
            food_items = []
            
            if isinstance(calories, dict):
                total_cals = float(calories.get("total", 0))
                protein = float(calories.get("protein", 0))
                fat = float(calories.get("fat", 0))
                carbs = float(calories.get("carbs", 0))
                food_items = calories.get("food_items", [])
            
            # Save to CalorieDetectionLog
            detection = CalorieDetectionLog(
                user_id=current_user.id,
                food_items=json.dumps(food_items),
                total_calories=total_cals,
                total_protein_g=protein,
                total_fat_g=fat,
                total_carbs_g=carbs,
                confidence_score=0.8  # Default confidence
            )
            db.session.add(detection)
            
            # Also create a meal log entry for backward compatibility
            meal_log = MealLog(
                user_id=current_user.id,
                total_calories=total_cals,
                protein_g=protein,
                fat_g=fat,
                carbs_g=carbs,
                photo_url="",
            )
            db.session.add(meal_log)
            db.session.commit()
            
        except Exception as e:
            print(f"Error logging detection: {e}")
            # Still return the calories even if logging fails

    return {"calories": calories}

@app.route("/exercise", methods=["GET", "POST"])
@login_required
def exercise():
    # Check if an exercise ID is provided
    exercise_id = request.args.get("id")
    answer = None
    
    if exercise_id:
        # If we have an exercise ID, fetch exercise data from ExerciseDB API
        try:
            import requests
            url = f"https://exercisedb.p.rapidapi.com/exercises/exercise/{exercise_id}"
            headers = {
                "X-RapidAPI-Key": os.getenv("EXERCISEDB_API_KEY"),
                "X-RapidAPI-Host": "exercisedb.p.rapidapi.com"
            }
            response = requests.get(url, headers=headers)
            if response.status_code == 200:
                answer = response.json()
            else:
                answer = {"name": "Exercise not found", "description": "Please try a different exercise."}
        except Exception as e:
            answer = {"name": "Error loading exercise", "description": str(e)}
    elif request.method == "POST":
        # Handle form submission for AI exercise advice
        prompt = request.form.get("prompt", "")
        if prompt:
            try:
                resp = openai_client.chat.completions.create(
                    model="gpt-4o-mini",
                    messages=[
                        {"role": "system", "content": "You are a fitness coach. Provide safe, concise guidance."},
                        {"role": "user", "content": prompt},
                    ],
                )
                # Create a structured answer for the template
                content = resp.choices[0].message.content
                answer = {
                    "name": "AI Exercise Advice",
                    "description": content,
                    "target": "General Fitness",
                    "bodyPart": "Full Body",
                    "equipment": "Varies",
                    "difficulty": "Beginner to Advanced"
                }
            except Exception as e:
                answer = {"name": "Error", "description": f"Error: {e}"}
    else:
        # Default case - show a welcome message
        answer = {
            "name": "Advanced Exercise Guide",
            "description": "Select an exercise from the gym page to see detailed information, or use the form below to get AI-powered exercise advice.",
            "target": "Multiple",
            "bodyPart": "Full Body",
            "equipment": "Various",
            "difficulty": "All Levels"
        }
    
    return render_template("exercise.html", answer=answer)

@app.route("/api/ai/workout-plan", methods=["POST"])
@login_required
def generate_workout_plan():
    """Generate AI-powered workout plan using OpenAI"""
    data = request.get_json()
    if not data:
        return {"error": "No data provided"}, 400
    
    fitness_level = data.get("fitness_level", "intermediate")
    goal = data.get("goal", "general_fitness")
    duration = data.get("duration", 45)
    equipment = data.get("equipment", "basic")
    target_muscles = data.get("target_muscles", "")
    
    # Create a simple fallback plan first
    fallback_plan = {
        "title": f"{goal.replace('_', ' ').title()} Workout Plan",
        "total_duration": duration,
        "estimated_calories": 200 + (duration * 3),
        "exercises": [
            {
                "name": "Warm-up",
                "sets": 1,
                "reps": "5-10 minutes",
                "rest": "0s",
                "duration": 5,
                "target_muscles": "Full body",
                "notes": "Light cardio and dynamic stretching"
            },
            {
                "name": "Push-ups",
                "sets": 3,
                "reps": "8-15",
                "rest": "60s",
                "duration": 10,
                "target_muscles": "Chest, shoulders, triceps",
                "notes": "Keep core tight, lower chest to ground"
            },
            {
                "name": "Bodyweight Squats",
                "sets": 3,
                "reps": "12-20",
                "rest": "60s",
                "duration": 10,
                "target_muscles": "Quads, glutes, hamstrings",
                "notes": "Keep back straight, go to parallel or lower"
            },
            {
                "name": "Plank",
                "sets": 3,
                "reps": "30-60 seconds",
                "rest": "30s",
                "duration": 5,
                "target_muscles": "Core, shoulders",
                "notes": "Keep body in straight line, engage core"
            },
            {
                "name": "Cool-down",
                "sets": 1,
                "reps": "5-10 minutes",
                "rest": "0s",
                "duration": 5,
                "target_muscles": "Full body",
                "notes": "Static stretching, hold each stretch 20-30s"
            }
        ]
    }
    
    # Try AI generation, but return fallback if anything fails
    try:
        prompt = f"""
    Generate a workout plan for {fitness_level} level, goal: {goal}, {duration} minutes, equipment: {equipment}, target: {target_muscles if target_muscles else 'full body'}.
    
    Return ONLY this JSON format:
    {{
        "title": "Workout Name",
        "total_duration": {duration},
        "estimated_calories": 300,
        "exercises": [
            {{
                "name": "Exercise Name",
                "sets": 3,
                "reps": "8-12",
                "rest": "60s",
                "duration": 10,
                "target_muscles": "Muscles worked",
                "notes": "Form tips"
            }}
        ]
    }}
    """
        
        resp = openai_client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": "You are a fitness trainer. Return only valid JSON workout plans."},
                {"role": "user", "content": prompt}
            ],
            temperature=0.3,
            max_tokens=800
        )
        
        content = resp.choices[0].message.content.strip()
        print(f"OpenAI response: {content}")  # Debug logging
        
        # Try to parse as JSON
        try:
            import json
            import re
            
            # Extract JSON from response (in case there's extra text)
            json_match = re.search(r'\{.*\}', content, re.DOTALL)
            if json_match:
                content = json_match.group(0)
            
            plan = json.loads(content)
            
            # Validate the plan structure
            if not isinstance(plan, dict) or 'exercises' not in plan:
                raise ValueError("Invalid plan structure")
            
            # Ensure required fields
            if 'title' not in plan:
                plan['title'] = fallback_plan['title']
            if 'total_duration' not in plan:
                plan['total_duration'] = duration
            if 'estimated_calories' not in plan:
                plan['estimated_calories'] = fallback_plan['estimated_calories']
                
            return jsonify(plan)
            
        except (json.JSONDecodeError, ValueError) as e:
            print(f"JSON parsing error: {e}")
            print(f"Content was: {content}")
            return jsonify(fallback_plan)
        
    except Exception as e:
        print(f"OpenAI API error: {e}")
        return jsonify(fallback_plan)

from datetime import datetime, timedelta

@app.template_filter('timestamp')
def timestamp_filter(value):
    """Add cache-busting timestamp"""
    return str(int(datetime.now().timestamp()))

@app.route("/camera-test")
def camera_test():
    """Simple camera test page to diagnose camera issues"""
    return render_template("camera-test.html")

@app.route("/exercise-advanced")
@login_required
def exercise_advanced():
    """Advanced real-time form analysis page - clean version"""
    return render_template("exercise-advanced.html")

@app.route("/api/ai/form-analysis", methods=["POST"])
@login_required
def form_analysis():
    """Form analysis endpoint for compatibility with existing code"""
    # This endpoint is deprecated - use the advanced pose detection instead
    return jsonify({
        "error": "This endpoint is deprecated. Please use the advanced pose detection at /exercise-advanced",
        "form_score": 85,
        "reps_counted": 0,
        "consistency": 80,
        "feedback": "Please use the advanced form analysis page",
        "severity": "warning"
    }), 200

@app.route("/chat", methods=["POST"]) 
def chat_api():
    data = request.get_json(silent=True) or {}
    msg = data.get("message", "")
    if not msg:
        return {"error": "message is required"}, 400
    try:
        resp = openai_client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": "You are a helpful health and nutrition assistant."},
                {"role": "user", "content": msg},
            ],
        )
        content = resp.choices[0].message.content
        return {"reply": content}
    except Exception as e:
        return {"error": str(e)}, 500


# ===== EXERCISEDB INTEGRATION =====


def search_exercisedb(query: str, body_part: Optional[str] = None, limit: int = 20):
    """Call ExerciseDB API and return a normalized list of exercises.

    EXERCISEDB_BASE_URL should point to the base API URL that returns a JSON
    array of exercises with fields: name, target, equipment, gifUrl, bodyPart.
    """
    if not EXERCISEDB_API_KEY or not EXERCISEDB_BASE_URL or not EXERCISEDB_HOST or not query:
        # Return empty list; caller can check env and report a clearer error
        return []
    try:
        headers = {
            # RapidAPI headers for ExerciseDB
            "X-RapidAPI-Key": EXERCISEDB_API_KEY,
            "X-RapidAPI-Host": EXERCISEDB_HOST,
        }
        resp = requests.get(EXERCISEDB_BASE_URL, headers=headers, timeout=8)
        if not resp.ok:
            print(f"ExerciseDB HTTP error: {resp.status_code} {resp.text[:200]}")
            return []

        raw = resp.json() or []
        # RapidAPI often wraps data: { "data": [...] }
        if isinstance(raw, dict) and "data" in raw:
            items = raw.get("data") or []
        else:
            items = raw if isinstance(raw, list) else []

        q = (query or "").strip().lower()
        muscle = (body_part or "").strip().lower()

        results = []
        for ex in items:
            if not isinstance(ex, dict):
                continue
            name = (ex.get("name") or "").strip()
            target = ex.get("target") or ""
            body_part_val = ex.get("bodyPart") or ""
            equipment = ex.get("equipment")
            gif_url = ex.get("gifUrl")

            if not name:
                continue

            # Same idea as user's searchExercises: match on name or target/bodyPart
            name_l = name.lower()
            target_body = f"{target} {body_part_val}".lower()
            matches_name = (q == "") or (q in name_l or q in target_body)
            matches_muscle = (muscle == "") or (muscle in target_body)
            if not (matches_name and matches_muscle):
                continue

            results.append(
                {
                    "name": name,
                    "target": target,
                    "equipment": equipment,
                    "gifUrl": gif_url,
                    "bodyPart": body_part_val,
                }
            )
            if len(results) >= limit:
                break
        return results
    except Exception as e:
        print(f"ExerciseDB error: {e}")
        return []


@app.route("/api/exercises/search", methods=["POST"])
@login_required
def exercises_search():
    """Search exercises from ExerciseDB by name/target and optional body part."""
    data = request.get_json() or {}
    query = (data.get("query") or "").strip()
    body_part = (data.get("body_part") or "").strip() or None
    if not query:
        return {"error": "query is required"}, 400
    if not EXERCISEDB_API_KEY:
        return {"error": "EXERCISEDB_API_KEY is not set in environment"}, 500
    if not EXERCISEDB_BASE_URL:
        return {"error": "EXERCISEDB_BASE_URL is not set in environment"}, 500
    # Return more than 10 exercises so the browser has plenty of options
    exercises = search_exercisedb(query=query, body_part=body_part, limit=40)
    return {"exercises": exercises}


# ===== WORKOUT / GYM TRACKING ENDPOINTS =====


def _get_or_create_today_session():
    today = datetime.utcnow().date()
    session = WorkoutSession.query.filter_by(
        user_id=current_user.id,
        date=today,
    ).order_by(WorkoutSession.id.asc()).first()
    if not session:
        session = WorkoutSession(user_id=current_user.id, date=today, name="Workout")
        db.session.add(session)
        db.session.commit()
    return session


@app.route("/api/workouts/today")
@login_required
def workouts_today():
    """Return today's workout session and sets for the current user."""
    session = _get_or_create_today_session()
    sets = [
        {
            "id": s.id,
            "exercise_name": s.exercise_name,
            "muscle_group": s.muscle_group,
            "sets": s.sets,
            "reps": s.reps,
            "weight": s.weight,
            "rpe": s.rpe,
            "notes": s.notes,
        }
        for s in session.sets
    ]
    return {
        "session": {
            "id": session.id,
            "date": session.date.isoformat(),
            "name": session.name,
            "notes": session.notes,
        },
        "sets": sets,
    }


@app.route("/api/workouts/session", methods=["POST"])
@login_required
def update_workout_session():
    """Update today's workout session name/notes."""
    data = request.get_json() or {}
    session = _get_or_create_today_session()
    session.name = data.get("name") or session.name
    session.notes = data.get("notes") or session.notes
    db.session.commit()
    return {"success": True}


@app.route("/api/workouts/set", methods=["POST"])
@login_required
def modify_workout_set():
    """Create, update, or delete a workout set.

    Expected JSON: {action: 'create'|'update'|'delete', ...}
    """
    data = request.get_json() or {}
    action = data.get("action", "create")

    if action == "create":
        session = _get_or_create_today_session()
        s = WorkoutSet(
            session_id=session.id,
            exercise_name=data.get("exercise_name", "Exercise"),
            muscle_group=data.get("muscle_group"),
            sets=int(data.get("sets", 1) or 1),
            reps=int(data.get("reps", 8) or 8),
            weight=float(data.get("weight", 0) or 0),
            rpe=float(data.get("rpe")) if data.get("rpe") is not None else None,
            notes=data.get("notes"),
        )
        db.session.add(s)
        db.session.commit()
        
        # Ingest into RAG user history for personalized AI responses
        try:
            from datetime import date
            workout_data = {
                'id': s.id,
                'date': date.today().isoformat(),
                'exercise': s.exercise_name,
                'sets': s.sets,
                'reps': s.reps,
                'weight': s.weight,
                'muscle_groups': s.muscle_group
            }
            ingest_user_workout(current_user.id, workout_data)
        except Exception as rag_e:
            print(f"RAG workout ingestion error (non-critical): {rag_e}")
        
        return {"success": True, "id": s.id}

    set_id = data.get("id")
    if not set_id:
        return {"error": "id is required for update/delete"}, 400

    s = WorkoutSet.query.join(WorkoutSession).filter(
        WorkoutSet.id == set_id,
        WorkoutSession.user_id == current_user.id,
    ).first()
    if not s:
        return {"error": "Set not found"}, 404

    if action == "delete":
        db.session.delete(s)
        db.session.commit()
        return {"success": True}

    # update
    if "exercise_name" in data:
        s.exercise_name = data.get("exercise_name") or s.exercise_name
    if "muscle_group" in data:
        s.muscle_group = data.get("muscle_group")
    if "sets" in data:
        s.sets = int(data.get("sets") or s.sets)
    if "reps" in data:
        s.reps = int(data.get("reps") or s.reps)
    if "weight" in data:
        s.weight = float(data.get("weight") or s.weight)
    if "rpe" in data:
        rpe_val = data.get("rpe")
        s.rpe = float(rpe_val) if rpe_val is not None else None
    if "notes" in data:
        s.notes = data.get("notes")

    db.session.commit()
    return {"success": True}

@app.route("/gym")
@login_required
def gym():
    return render_template("gym.html")


@app.route("/food_logging")
@login_required
def food_logging_page():
    """New unified food logging page (search + detection + AI analysis)."""
    return render_template("food_logging.html")


@app.route("/realtime")
@login_required
def realtime_page():
    return render_template("realtime.html")

@app.route("/realtime_feed")
@login_required
def realtime_feed():
    # Stream MJPEG with detections
    try:
        import cv2  # type: ignore
        import numpy as np  # noqa: F401
    except Exception:
        return Response("OpenCV (cv2) not installed. Please install opencv-python in your virtualenv.", status=500)

    model = get_yolo_model()
    if isinstance(model, Exception):
        return Response(f"Model load error: {model}", status=500)

    # Try multiple camera indices for robustness
    cap = None
    for idx in (0, 1, 2):
        c = cv2.VideoCapture(idx)
        if c.isOpened():
            cap = c
            break
        c.release()
    if cap is None:
        return Response("Webcam not available", status=500)

    def gen():
        try:
            while True:
                ok, frame = cap.read()
                if not ok:
                    break
                # Run detection with tunable params
                results = model.predict(source=frame, conf=float(os.getenv("YOLO_CONF", 0.25)), imgsz=int(os.getenv("YOLO_IMGSZ", 640)), verbose=False)
                # Draw boxes using ultralytics built-in plot()
                if results and len(results) > 0:
                    plotted = results[0].plot()
                else:
                    plotted = frame
                ret, jpeg = cv2.imencode('.jpg', plotted)
                if not ret:
                    continue
                data = jpeg.tobytes()
                yield (b'--frame\r\n'
                       b'Content-Type: image/jpeg\r\n\r\n' + data + b'\r\n')
        finally:
            cap.release()

    return Response(gen(), mimetype='multipart/x-mixed-replace; boundary=frame')

@app.route("/register", methods=["GET", "POST"])
def register():
    if request.method == "POST":
        email = request.form.get("email", "").strip().lower()
        password = request.form.get("password", "")
        if not email or not password:
            flash("Email and password are required", "error")
            return redirect(url_for("register"))
        existing = User.query.filter_by(email=email).first()
        if existing:
            flash("Email already registered", "error")
            return redirect(url_for("register"))
        user = User(email=email)
        user.set_password(password)
        db.session.add(user)
        db.session.commit()
        login_user(user)
        return redirect(url_for("profile"))
    return render_template("register.html")

@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        email = request.form.get("email", "").strip().lower()
        password = request.form.get("password", "")
        user = User.query.filter_by(email=email).first()
        if not user or not user.check_password(password):
            flash("Invalid credentials", "error")
            return redirect(url_for("login"))
        login_user(user)
        return redirect(url_for("dashboard"))
    return render_template("login.html")

@app.route("/logout")
@login_required
def logout():
    logout_user()
    return redirect(url_for("index"))

@app.route("/profile", methods=["GET", "POST"])
@login_required
def profile():
    profile = current_user.profile or Profile(user_id=current_user.id)
    if request.method == "POST":
        unit = request.form.get("unit_system", "metric")
        height = request.form.get("height_cm")
        weight = request.form.get("weight_kg")
        age = request.form.get("age")
        sex = request.form.get("sex")
        activity = request.form.get("activity_level")

        profile.unit_system = unit
        profile.height_cm = float(height) if height else None
        profile.weight_kg = float(weight) if weight else None
        profile.age = int(age) if age else None
        profile.sex = sex
        profile.activity_level = activity

        if not current_user.profile:
            db.session.add(profile)
        db.session.commit()
        flash("Profile saved", "success")
        return redirect(url_for("dashboard"))

    metrics = calculate_bmr_tdee(profile) if current_user.profile else {"bmr": None, "tdee": None}
    return render_template("profile.html", profile=profile, metrics=metrics)

@app.route("/dashboard")
@login_required
def dashboard():
    logs = MealLog.query.filter_by(user_id=current_user.id).order_by(MealLog.timestamp.desc()).limit(20).all()
    prof = current_user.profile
    metrics = calculate_bmr_tdee(prof) if prof else {"bmr": None, "tdee": None}
    
    # Calculate today's nutrition totals
    today_logs = [l for l in logs if l.timestamp.date() == datetime.utcnow().date()]
    today_total = sum(l.total_calories or 0 for l in today_logs)
    today_protein = sum(l.protein_g or 0 for l in today_logs)
    today_carbs = sum(l.carbs_g or 0 for l in today_logs)
    today_fat = sum(l.fat_g or 0 for l in today_logs)
    
    # Calculate macro targets
    if prof and metrics.get("tdee"):
        macro_targets = calculate_macro_split(metrics["tdee"], "maintain_weight", prof.activity_level)
    else:
        macro_targets = {"protein_g": 150, "carbs_g": 250, "fat_g": 65}
    
    return render_template("dashboard.html", 
                         logs=logs, 
                         metrics=metrics, 
                         today_total=round(today_total),
                         today_protein=round(today_protein),
                         today_carbs=round(today_carbs),
                         today_fat=round(today_fat),
                         macro_targets=macro_targets)

def calculate_body_fat_percentage(sex, height_cm, waist_cm, neck_cm):
    """Calculate body fat percentage using US Navy formula"""
    try:
        if sex.lower() == 'male':
            # US Navy body fat formula for males
            body_fat = 86.010 * math.log10(waist_cm - neck_cm) - 70.041 * math.log10(height_cm) + 36.76
        else:
            # US Navy body fat formula for females (hip measurement needed, using approximation)
            body_fat = 163.34 * math.log10(waist_cm + neck_cm) - 97.68 * math.log10(height_cm) - 78.36
        
        return max(0, min(50, body_fat))  # Clamp between 0-50%
    except:
        return None

def calculate_macro_split(target_calories, goal, exercise_level):
    """Calculate macronutrient split based on goals and activity level"""
    
    # Base macro ratios
    if goal == 'lose_weight':
        protein_ratio = 0.35  # Higher protein for satiety and muscle preservation
        carbs_ratio = 0.30
        fats_ratio = 0.35
    elif goal == 'gain_muscle':
        protein_ratio = 0.30  # High protein for muscle building
        carbs_ratio = 0.45    # High carbs for energy
        fats_ratio = 0.25
    elif goal == 'gain_weight':
        protein_ratio = 0.25
        carbs_ratio = 0.45
        fats_ratio = 0.30
    else:  # maintain_weight
        protein_ratio = 0.25
        carbs_ratio = 0.40
        fats_ratio = 0.35
    
    # Adjust based on exercise level
    if exercise_level in ['advanced', 'athlete']:
        carbs_ratio += 0.05
        fats_ratio -= 0.05
    elif exercise_level == 'beginner':
        protein_ratio += 0.05
        carbs_ratio -= 0.05
    
    # Calculate grams and calories
    protein_calories = target_calories * protein_ratio
    carbs_calories = target_calories * carbs_ratio
    fats_calories = target_calories * fats_ratio
    
    return {
        'protein_g': round(protein_calories / 4, 1),
        'carbs_g': round(carbs_calories / 4, 1),
        'fats_g': round(fats_calories / 9, 1),
        'protein_calories': round(protein_calories),
        'carbs_calories': round(carbs_calories),
        'fats_calories': round(fats_calories),
        'protein_percentage': round(protein_ratio * 100),
        'carbs_percentage': round(carbs_ratio * 100),
        'fats_percentage': round(fats_ratio * 100)
    }

def calculate_target_calories(tdee, goal, exercise_level):
    """Calculate target calories based on goal"""
    if goal == 'lose_weight':
        # 500 calorie deficit for ~1lb/week loss
        return tdee - 500
    elif goal == 'gain_weight':
        # 300-500 calorie surplus for weight gain
        return tdee + 400
    elif goal == 'gain_muscle':
        # Moderate surplus with focus on protein
        return tdee + 300
    else:  # maintain_weight
        return tdee

# ===== ADVANCED RAG SYSTEM WITH CHROMADB =====

# Initialize ChromaDB
chroma_client = chromadb.PersistentClient(path="./chroma_db")
collection = chroma_client.get_or_create_collection(
    name="nutrition_knowledge",
    metadata={"description": "Nutrition and fitness knowledge base"}
)

def generate_embedding(text):
    """Generate embedding for text using OpenAI"""
    try:
        response = openai_client.embeddings.create(
            model="text-embedding-ada-002",
            input=text
        )
        return response.data[0].embedding
    except Exception as e:
        print(f"Error generating embedding: {e}")
        return None

def add_document_to_chroma(doc_id, title, content, category, tags):
    """Add document to ChromaDB vector store"""
    try:
        # Generate embedding
        embedding = generate_embedding(content)
        if not embedding:
            return False
        
        # Add to ChromaDB
        collection.add(
            ids=[str(doc_id)],
            embeddings=[embedding],
            metadatas=[{
                "title": title,
                "category": category,
                "tags": tags,
                "source": "Internal Knowledge Base"
            }],
            documents=[content]
        )
        return True
    except Exception as e:
        print(f"Error adding document to ChromaDB: {e}")
        return False

def advanced_retrieve_relevant_context(query, category=None, limit=5, user_profile=None):
    """Advanced document retrieval with filtering and re-ranking"""
    try:
        # Generate query embedding
        query_embedding = generate_embedding(query)
        if not query_embedding:
            return []
        
        # Build where clause for category filtering
        where_clause = {}
        if category:
            where_clause["category"] = category
        
        # Query ChromaDB
        results = collection.query(
            query_embeddings=[query_embedding],
            n_results=limit * 2,  # Get more for re-ranking
            where=where_clause if where_clause else None,
            include=["metadatas", "documents", "distances"]
        )
        
        if not results or not results["ids"][0]:
            return []
        
        # Re-rank results based on user profile relevance
        documents = []
        for i, doc_id in enumerate(results["ids"][0]):
            metadata = results["metadatas"][0][i]
            document = results["documents"][0][i]
            distance = results["distances"][0][i]
            
            # Calculate relevance score based on user profile
            relevance_score = calculate_relevance_score(query, document, metadata, user_profile)
            
            documents.append({
                "id": doc_id,
                "title": metadata["title"],
                "content": document,
                "category": metadata["category"],
                "tags": metadata["tags"],
                "similarity_score": 1 - distance,  # Convert distance to similarity
                "relevance_score": relevance_score,
                "combined_score": (1 - distance) * 0.7 + relevance_score * 0.3
            })
        
        # Sort by combined score and return top results
        documents.sort(key=lambda x: x["combined_score"], reverse=True)
        return documents[:limit]
        
    except Exception as e:
        print(f"Error in advanced retrieval: {e}")
        return []

def calculate_relevance_score(query, document, metadata, user_profile):
    """Calculate relevance score based on user profile and query terms"""
    score = 0.5  # Base score
    
    if user_profile:
        # Boost score based on user goals and characteristics
        if user_profile.get("goal"):
            if user_profile["goal"].lower() in document.lower():
                score += 0.2
        
        if user_profile.get("exercise_level"):
            if user_profile["exercise_level"].lower() in document.lower():
                score += 0.15
        
        if user_profile.get("sex"):
            gender_terms = ["male", "female", "men", "women"]
            for term in gender_terms:
                if term in document.lower() and term == user_profile["sex"].lower():
                    score += 0.1
                    break
    
    # Boost score for exact query matches
    query_words = query.lower().split()
    for word in query_words:
        if word in document.lower():
            score += 0.05
    
    return min(score, 1.0)  # Cap at 1.0

def expand_query(query):
    """Expand query with related terms for better retrieval"""
    expansions = {
        "weight loss": ["fat loss", "calorie deficit", "slimming", "cutting"],
        "muscle gain": ["bulking", "mass building", "hypertrophy", "strength training"],
        "protein": ["amino acids", "muscle protein synthesis", "whey", "casein"],
        "exercise": ["workout", "training", "fitness", "physical activity"],
        "diet": ["nutrition", "meal plan", "eating plan", "food intake"]
    }
    
    expanded_query = query.lower()
    for key, terms in expansions.items():
        if key in expanded_query:
            expanded_query += " " + " ".join(terms)
    
    return expanded_query

def chunk_document(content, chunk_size=500, overlap=100):
    """Chunk large documents for better retrieval"""
    if len(content) <= chunk_size:
        return [content]
    
    chunks = []
    start = 0
    
    while start < len(content):
        end = start + chunk_size
        if end > len(content):
            end = len(content)
        
        chunk = content[start:end]
        chunks.append(chunk)
        
        start = end - overlap
        if start >= len(content):
            break
    
    return chunks

def advanced_rag_augmented_prompt(query, retrieved_docs, user_context=None):
    """Create advanced RAG-augmented prompt with citations"""
    context = "\n\n".join([
        f"[Source {i+1}] {doc['title']} (Category: {doc['category']}, Relevance: {doc['combined_score']:.2f})\n{doc['content']}"
        for i, doc in enumerate(retrieved_docs)
    ])
    
    user_context_str = ""
    if user_context:
        user_context_str = f"\n\nUser Profile Context:\n{user_context}"
    
    augmented_prompt = f"""🧠 ADVANCED RAG SYSTEM ACTIVATED 🧠

You are an elite nutritionist and fitness trainer with access to a specialized knowledge base. The following documents have been retrieved and ranked by relevance to provide evidence-based guidance.

📚 RETRIEVED KNOWLEDGE BASE:
{context}

{user_context_str}

❓ USER QUERY: {query}

🎯 INSTRUCTIONS:
1. Use the retrieved documents as your primary source of information
2. Cite sources using [Source X] references
3. If documents don't fully address the query, supplement with your expertise
4. Provide specific, actionable advice based on the user's profile
5. Highlight when information comes from the knowledge base vs. your general knowledge
6. Include confidence levels for recommendations

✨ RESPONSE FORMAT:
- Start with a confidence indicator [High/Medium/Low]
- Use citations [Source X] when referencing retrieved documents
- Provide specific, numbered recommendations
- Include practical implementation steps

Answer:"""
    
    return augmented_prompt

def initialize_knowledge_base():
    """Initialize the advanced knowledge base with comprehensive nutrition and fitness information"""
    knowledge_items = [
        {
            "title": "Understanding Macronutrients",
            "content": "Macronutrients are nutrients that provide calories or energy. The three main types are: 1) Proteins - 4 calories per gram, essential for muscle repair and growth. Found in meat, fish, eggs, dairy, legumes. 2) Carbohydrates - 4 calories per gram, primary energy source. Found in grains, fruits, vegetables. 3) Fats - 9 calories per gram, energy storage and hormone production. Found in oils, nuts, seeds, fatty fish.",
            "category": "nutrition",
            "tags": "macronutrients,protein,carbs,fats,basics"
        },
        {
            "title": "Advanced Calorie Deficit Strategies",
            "content": "Strategic calorie deficit for sustainable weight loss: 500-750 calories daily deficit for 1-1.5 lbs/week loss. Use diet breaks every 8-12 weeks at maintenance calories. Incorporate refeed days with higher carbs (100-200g above baseline) every 2-3 weeks during extended deficits. Monitor metabolic rate and adjust deficits as weight loss progresses.",
            "category": "nutrition",
            "tags": "weight loss,calories,deficit,metabolic adaptation"
        },
        {
            "title": "Protein Timing and Distribution",
            "content": "Optimal protein distribution: 20-30g per meal across 3-4 meals daily. Pre-workout protein 20-30g 1-2 hours before training. Post-workout protein 25-40g within 30 minutes for muscle protein synthesis. Casein protein before bed for overnight recovery. Total daily protein: 1.6-2.2g/kg for strength athletes, 1.2-1.6g/kg for endurance athletes.",
            "category": "nutrition",
            "tags": "protein,timing,muscle synthesis,recovery"
        },
        {
            "title": "Body Composition Beyond BMI",
            "content": "Advanced body composition assessment: BMI limitations for athletes with high muscle mass. Waist-to-height ratio <0.5 for optimal health. Body fat percentage ranges: Essential fat 10-13% (men), 13-17% (women); Athletic 6-13% (men), 14-20% (women); Fitness 14-17% (men), 21-24% (women). Use DEXA, BodPod, or calipers for accurate measurements.",
            "category": "health",
            "tags": "BMI,body composition,waist ratio,body fat"
        },
        {
            "title": "Progressive Overload Training Principles",
            "content": "Progressive overload fundamentals: 1) Increase weight gradually (2.5-5lbs for upper body, 5-10lbs for lower body). 2) Increase repetitions within target range (8-12 for hypertrophy). 3) Increase training volume (sets x reps x weight). 4) Decrease rest periods. 5) Increase training frequency. Track workouts and apply 2-for-2 rule: if you can complete 2 extra reps on 2 consecutive workouts, increase weight.",
            "category": "exercise",
            "tags": "progressive overload,strength training,hypertrophy"
        },
        {
            "title": "Advanced Hydration Strategies",
            "content": "Precision hydration: Base intake 35ml/kg body weight daily. Add 500-750ml per hour of exercise. For workouts >90 minutes, add electrolytes (300-600mg sodium, 75-150mg potassium per liter). Pre-hydrate with 5-7ml/kg 2-4 hours before exercise. Monitor urine specific gravity (1.005-1.015 optimal). Consider sweat rate testing for individualized hydration plans.",
            "category": "health",
            "tags": "hydration,electrolytes,sweat rate,performance"
        },
        {
            "title": "Nutrient Timing for Performance",
            "content": "Strategic nutrient timing: Pre-workout meal 2-3 hours before: 1-2g carbs/kg, 0.2-0.3g protein/kg. Intra-workout carbs (60-90g/hour) for sessions >90 minutes. Post-workout anabolic window: 1-1.2g carbs/kg, 0.3-0.4g protein/kg within 30 minutes. Bedtime casein (20-40g) for overnight muscle protein synthesis.",
            "category": "nutrition",
            "tags": "nutrient timing,performance,carbs,protein"
        },
        {
            "title": "Complete Protein Food Database",
            "content": "Comprehensive protein sources: Animal proteins (complete amino acid profile) - whey isolate (90% protein, fast absorption), casein (80% protein, slow release), eggs (13g/100g), chicken breast (31g/100g), salmon (25g/100g). Plant proteins - soy isolate (90% protein, complete), quinoa (8g/100g complete), hemp seeds (25g/100g complete), rice + bean combinations. Digestibility scores: whey 99%, egg 97%, milk 95%, soy 91%, beef 90%.",
            "category": "nutrition",
            "tags": "protein,amino acids,food sources,complete proteins"
        },
        {
            "title": "Metabolic Adaptation Management",
            "content": "Combating metabolic adaptation during dieting: Implement diet breaks every 8-12 weeks at maintenance calories for 1-2 weeks. Use refeed days with 100-200g increased carbs every 2-3 weeks. Gradually increase calories (100-200 weekly) when reaching plateau. Monitor resting metabolic rate and adjust targets accordingly. Include high-carb days to replenish glycogen and boost leptin.",
            "category": "nutrition",
            "tags": "metabolic adaptation,diet breaks,refeed,leptin"
        },
        {
            "title": "Recovery and Sleep Optimization",
            "content": "Recovery optimization: 7-9 hours sleep quality for muscle recovery and hormone regulation. Sleep hygiene: cool room (65-68°F), complete darkness, no screens 1 hour before bed. Protein before sleep: 20-40g casein or slow-digesting protein. Magnesium (400mg) and zinc (30mg) before bed for recovery. Morning sunlight exposure for circadian rhythm regulation.",
            "category": "health",
            "tags": "recovery,sleep,magnesium,zinc,circadian"
        },
        {
            "title": "Supplement Evidence Guide",
            "content": "Evidence-based supplements: Creatine monohydrate (5g daily) - strength and power gains, extensive research support. Beta-alanine (3.2-6.4g daily) - muscular endurance, buffering capacity. Caffeine (3-6mg/kg) pre-workout - performance enhancement. Omega-3 fatty acids (2-4g EPA/DHA) - inflammation reduction. Vitamin D (2000-4000 IU) - hormone optimization, immune function.",
            "category": "health",
            "tags": "supplements,creatine,beta-alanine,caffeine,omega-3"
        },
        {
            "title": "Female-Specific Nutrition Strategies",
            "content": "Women's nutrition considerations: Iron needs higher (18mg pre-menopause, 8mg post-menopause). Calcium needs increase with age (1000-1200mg daily). Folate requirements (400-600mcg) during reproductive years. Consider menstrual cycle impacts on training: follicular phase better for high intensity, luteal phase better for moderate intensity. Adjust calories based on cycle phase.",
            "category": "nutrition",
            "tags": "female nutrition,iron,calcium,menstrual cycle"
        }
    ]
    
    # Clear existing collection for fresh start
    try:
        collection.delete()
        print("Cleared existing ChromaDB collection")
    except:
        pass
    
    # Add documents to ChromaDB
    for i, item in enumerate(knowledge_items):
        doc_id = f"doc_{i+1}"
        success = add_document_to_chroma(
            doc_id,
            item['title'],
            item['content'],
            item['category'],
            item['tags']
        )
        if success:
            print(f"Added to ChromaDB: {item['title']}")
        else:
            print(f"Failed to add: {item['title']}")
    
    print("Advanced knowledge base initialized successfully")

@app.route("/body_analysis")
@login_required
def body_analysis():
    profile = Profile.query.filter_by(user_id=current_user.id).first()
    return render_template("body_analysis.html", profile=profile)


@app.route("/weekly_review")
@login_required
def weekly_review_page():
    """Weekly review page with 7-day trends and AI summary."""
    return render_template("weekly_review.html")

@app.route("/api/body_analysis", methods=["POST"])
@login_required
def analyze_body():
    data = request.get_json()
    try:
        # Extract and validate form data
        age = int(data.get('age'))
        sex = data.get('sex')
        height_cm = float(data.get('height_cm'))
        weight_kg = float(data.get('weight_kg'))
        waist_cm = float(data.get('waist_cm'))
        neck_cm = float(data.get('neck_cm'))
        goal = data.get('goal')
        exercise_level = data.get('exercise_level')
        work_activity_level = data.get('work_activity_level')
        activity_level = data.get('activity_level')
        
        # Calculate BMI
        height_m = height_cm / 100
        bmi = weight_kg / (height_m ** 2)
        
        # Calculate BMR and TDEE
        if sex.lower() == 'male':
            bmr = 10 * weight_kg + 6.25 * height_cm - 5 * age + 5
        else:
            bmr = 10 * weight_kg + 6.25 * height_cm - 5 * age - 161
        
        activity_multipliers = {
            'sedentary': 1.2,
            'light': 1.375,
            'moderate': 1.55,
            'active': 1.725,
            'athlete': 1.9
        }
        tdee = bmr * activity_multipliers.get(activity_level.lower(), 1.2)
        
        # Calculate target calories
        target_calories = calculate_target_calories(tdee, goal, exercise_level)
        
        # Calculate body fat percentage
        body_fat_percentage = calculate_body_fat_percentage(sex, height_cm, waist_cm, neck_cm)
        
        # Calculate macro split
        macros = calculate_macro_split(target_calories, goal, exercise_level)
        
        # Generate AI-powered analysis with ADVANCED RAG
        user_context = {
            "age": age,
            "sex": sex,
            "height_cm": height_cm,
            "weight_kg": weight_kg,
            "bmi": bmi,
            "body_fat_percentage": body_fat_percentage,
            "exercise_level": exercise_level,
            "work_activity_level": work_activity_level,
            "goal": goal,
            "target_calories": round(target_calories),
            "macros": macros
        }
        
        # Expand query for better retrieval
        expanded_query = expand_query(
            f"personalized nutrition plan for {goal} with {exercise_level} exercise level"
        )
        
        # Retrieve relevant documents using advanced RAG
        retrieved_docs = advanced_retrieve_relevant_context(
            expanded_query, 
            category="nutrition", 
            limit=3,
            user_profile=user_context
        )
        
        # Add exercise-related documents
        exercise_query = expand_query(
            f"exercise recommendations for {exercise_level} level"
        )
        exercise_docs = advanced_retrieve_relevant_context(
            exercise_query, 
            category="exercise", 
            limit=2,
            user_profile=user_context
        )
        retrieved_docs.extend(exercise_docs)
        
        # Add health-related documents
        health_query = expand_query(
            f"health tips for {goal}"
        )
        health_docs = advanced_retrieve_relevant_context(
            health_query, 
            category="health", 
            limit=2,
            user_profile=user_context
        )
        retrieved_docs.extend(health_docs)
        
        # Create advanced RAG-augmented prompt
        ai_prompt = advanced_rag_augmented_prompt(
            "Create a comprehensive, personalized nutrition and fitness plan based on detailed user metrics and goals. Include executive summary, nutrition strategy, exercise recommendations, weekly schedule, progress tracking, and advanced tips.",
            retrieved_docs,
            f"User Profile: Age {age}y, Gender {sex}, Height {height_cm}cm, Weight {weight_kg}kg, BMI {bmi:.1f}, Body Fat {body_fat_percentage:.1f}%, Exercise Level {exercise_level}, Goal {goal}, Target Calories {round(target_calories)}, Macros: Protein {macros['protein_g']}g, Carbs {macros['carbs_g']}g, Fats {macros['fats_g']}g"
        )
        
        response = openai_client.chat.completions.create(
            model="gpt-4",
            messages=[
                {
                    "role": "system",
                    "content": "You are an elite nutritionist and fitness trainer with expertise in metabolic health, body composition, and performance optimization. Provide evidence-based, personalized recommendations that are safe and effective."
                },
                {
                    "role": "user",
                    "content": ai_prompt
                }
            ],
            max_tokens=1500,
            temperature=0.7
        )
        
        # Update user profile with new measurements
        profile = Profile.query.filter_by(user_id=current_user.id).first()
        if profile:
            profile.age = age
            profile.sex = sex
            profile.height_cm = height_cm
            profile.weight_kg = weight_kg
            profile.waist_cm = waist_cm
            profile.neck_cm = neck_cm
            profile.activity_level = activity_level
            profile.exercise_level = exercise_level
            profile.work_activity_level = work_activity_level
            db.session.commit()
        
        # Save daily targets based on body analysis
        today = datetime.utcnow().date()
        existing_target = DailyTargets.query.filter_by(
            user_id=current_user.id, 
            date=today
        ).first()
        
        if not existing_target:
            daily_target = DailyTargets(
                user_id=current_user.id,
                date=today,
                target_calories=round(target_calories),
                target_protein_g=macros['protein_g'],
                target_fat_g=macros['fats_g'],
                target_carbs_g=macros['carbs_g']
            )
            db.session.add(daily_target)
            db.session.commit()
        
        return {
            "analysis": response.choices[0].message.content,
            "bmi": bmi,
            "tdee": tdee,
            "target_calories": target_calories,
            "body_fat_percentage": body_fat_percentage,
            "macros": macros,
            "rag_info": {
                "system_active": True,
                "retrieved_documents": len(retrieved_docs),
                "sources": [
                    {
                        "title": doc["title"],
                        "category": doc["category"],
                        "relevance_score": round(doc["combined_score"], 3),
                        "similarity_score": round(doc["similarity_score"], 3)
                    }
                    for doc in retrieved_docs
                ]
            }
        }
        
    except Exception as e:
        print(f"Error in body analysis: {str(e)}")
        return {"error": f"Analysis failed: {str(e)}"}

# ===== RAG ENDPOINTS (replaced by new RAG system below) =====

# ===== TEST ROUTE =====

@app.route("/test_food_page")
@login_required
def test_food_page():
    return "<h1 style='color: red;'>This is a TEST page. If you see this, the server is working!</h1>"

"""USDA helper: fetch foods from USDA FoodData Central and map to search result format."""


def fetch_usda_foods(query: str, limit: int = 10):
    if not USDA_API_KEY or not query:
        return []
    try:
        params = {
            "api_key": USDA_API_KEY,
            "query": query,
            "pageSize": limit,
            "dataType": ["Survey (FNDDS)", "SR Legacy"],
        }
        resp = requests.get(
            "https://api.nal.usda.gov/fdc/v1/foods/search",
            params=params,
            timeout=5,
        )
        if not resp.ok:
            return []
        data = resp.json()
        results = []
        for item in data.get("foods", []):
            fdc_id = item.get("fdcId")
            description = item.get("description") or "Food"
            brand = item.get("brandOwner")
            serving_qty = 100
            serving_unit = "g"

            calories = protein = carbs = fat = fiber = 0.0
            for n in item.get("foodNutrients", []):
                name = (n.get("nutrientName") or "").lower()
                amount = float(n.get("value") or 0)
                if "energy" in name and "kj" not in name:
                    calories = amount
                elif "protein" in name:
                    protein = amount
                elif "carbohydrate" in name:
                    carbs = amount
                elif "lipid" in name or "fat" in name:
                    fat = amount
                elif "fiber" in name:
                    fiber = amount

            results.append(
                {
                    "id": f"usda:{fdc_id}",
                    "name": description,
                    "brand": brand,
                    "serving_qty": serving_qty,
                    "serving_unit": serving_unit,
                    "calories": calories,
                    "protein_g": protein,
                    "fat_g": fat,
                    "carbs_g": carbs,
                    "fiber_g": fiber,
                    "source": "usda",
                }
            )
        return results
    except Exception:
        return []


# ===== FOOD LOGGING ENDPOINTS =====


@app.route("/api/search_food", methods=["POST"])
@login_required
def search_food():
    """Search for food items in local DB, then fall back to USDA API."""
    try:
        data = request.get_json()
        query = (data.get("query", "") or "").strip()

        if not query:
            return {"error": "Search query is required"}, 400

        results = []

        # 1) Search local FoodItem/Nutrients first
        foods = (
            FoodItem.query.filter(FoodItem.name.ilike(f"%{query}%"))
            .limit(20)
            .all()
        )

        for food in foods:
            nutrients = Nutrients.query.filter_by(food_id=food.id).first()
            if not nutrients:
                continue
            results.append(
                {
                    "id": food.id,
                    "name": food.name,
                    "brand": food.brand,
                    "serving_qty": food.serving_qty,
                    "serving_unit": food.serving_unit,
                    "calories": nutrients.calories,
                    "protein_g": nutrients.protein_g,
                    "fat_g": nutrients.fat_g,
                    "carbs_g": nutrients.carbs_g,
                    "fiber_g": nutrients.fiber_g,
                    "source": "local",
                }
            )

        # 2) If few local results, fall back to USDA
        if len(results) < 5:
            usda_results = fetch_usda_foods(query, limit=10)
            results.extend(usda_results)

        return {"foods": results}

    except Exception as e:
        return {"error": str(e)}


@app.route("/api/log_usda_food", methods=["POST"])
@login_required
def log_usda_food():
    """Log a food item coming directly from USDA search (no FoodItem row)."""
    try:
        data = request.get_json() or {}
        name = data.get("name") or "Food"
        quantity = float(data.get("quantity", 1.0) or 1.0)
        meal_type = data.get("meal_type", "snack")

        calories = float(data.get("calories", 0) or 0)
        protein = float(data.get("protein_g", 0) or 0)
        fat = float(data.get("fat_g", 0) or 0)
        carbs = float(data.get("carbs_g", 0) or 0)

        total_calories = calories * quantity
        total_protein = protein * quantity
        total_fat = fat * quantity
        total_carbs = carbs * quantity

        meal_log = MealLog(
            user_id=current_user.id,
            food_id=None,
            quantity=quantity,
            portion_text=f"{quantity} serving(s)",
            total_calories=total_calories,
            meal_type=meal_type,
            protein_g=total_protein,
            fat_g=total_fat,
            carbs_g=total_carbs,
        )

        db.session.add(meal_log)
        db.session.commit()

        # Ingest into RAG user history for personalized AI responses
        try:
            from datetime import date
            meal_data = {
                'id': meal_log.id,
                'date': date.today().isoformat(),
                'food_name': name,
                'calories': total_calories,
                'protein': total_protein,
                'carbs': total_carbs,
                'fat': total_fat,
                'meal_type': meal_type
            }
            ingest_user_meal_log(current_user.id, meal_data)
        except Exception as rag_e:
            print(f"RAG ingestion error (non-critical): {rag_e}")

        return {
            "success": True,
            "meal_id": meal_log.id,
            "total_calories": total_calories,
            "total_protein": total_protein,
            "total_fat": total_fat,
            "total_carbs": total_carbs,
        }
    except Exception as e:
        db.session.rollback()
        return {"error": str(e)}, 500

@app.route("/api/log_food", methods=["POST"])
@login_required
def log_food():
    """Log a food item for the user"""
    try:
        data = request.get_json()
        food_id = data.get('food_id')
        quantity = data.get('quantity', 1.0)
        meal_type = data.get('meal_type', 'snack')  # breakfast, lunch, dinner, snack
        
        if not food_id:
            return {"error": "Food ID is required"}, 400
        
        # Get food and nutrients
        food = FoodItem.query.get(food_id)
        if not food:
            return {"error": "Food not found"}, 404
        
        nutrients = Nutrients.query.filter_by(food_id=food_id).first()
        if not nutrients:
            return {"error": "Nutrition data not found"}, 404
        
        # Calculate total nutrients based on quantity
        multiplier = quantity / food.serving_qty if food.serving_qty else quantity
        total_calories = float(nutrients.calories or 0) * multiplier
        total_protein = float(nutrients.protein_g or 0) * multiplier
        total_fat = float(nutrients.fat_g or 0) * multiplier
        total_carbs = float(nutrients.carbs_g or 0) * multiplier
        
        # Create meal log with macro totals
        meal_log = MealLog(
            user_id=current_user.id,
            food_id=food_id,
            quantity=quantity,
            portion_text=f"{quantity} {food.serving_unit or 'serving'}",
            total_calories=total_calories,
            meal_type=meal_type,
            protein_g=total_protein,
            fat_g=total_fat,
            carbs_g=total_carbs,
        )
        
        db.session.add(meal_log)
        db.session.commit()
        
        # Update daily progress
        today = datetime.utcnow().date()
        progress = DailyProgress.query.filter_by(
            user_id=current_user.id,
            date=today
        ).first()
        
        if not progress:
            progress = DailyProgress(
                user_id=current_user.id,
                date=today
            )
            db.session.add(progress)
        
        # Update consumed values
        progress.consumed_calories += total_calories
        progress.consumed_protein_g += total_protein
        progress.consumed_fat_g += total_fat
        progress.consumed_carbs_g += total_carbs
        progress.meals_logged += 1
        progress.last_updated = datetime.utcnow()
        
        db.session.commit()
        
        # Ingest into RAG user history for personalized AI responses
        try:
            meal_data = {
                'id': meal_log.id,
                'date': today.isoformat(),
                'food_name': food.name,
                'calories': total_calories,
                'protein': total_protein,
                'carbs': total_carbs,
                'fat': total_fat,
                'meal_type': meal_type
            }
            ingest_user_meal_log(current_user.id, meal_data)
        except Exception as rag_e:
            print(f"RAG ingestion error (non-critical): {rag_e}")
        
        return {
            "success": True,
            "meal_id": meal_log.id,
            "total_calories": total_calories,
            "total_protein": total_protein,
            "total_fat": total_fat,
            "total_carbs": total_carbs
        }
        
    except Exception as e:
        db.session.rollback()
        return {"error": str(e)}


@app.route("/api/food_day_summary")
@login_required
def food_day_summary():
    """Return today's logged meals with basic macro breakdown for the UI table."""
    try:
        today = datetime.utcnow().date()
        start_dt = datetime.combine(today, datetime.min.time())
        end_dt = datetime.combine(today, datetime.max.time())

        meals = MealLog.query.filter(
            MealLog.user_id == current_user.id,
            MealLog.timestamp >= start_dt,
            MealLog.timestamp <= end_dt,
        ).order_by(MealLog.timestamp.asc()).all()

        results = []
        for m in meals:
            food = None
            try:
                food = m.food  # if relationship exists
            except Exception:
                food = None

            name = getattr(m, "food_name", None)
            if not name:
                if food is not None:
                    name = getattr(food, "name", None)
                elif m.food_id:
                    # Fallback: direct lookup by food_id
                    fi = FoodItem.query.get(m.food_id)
                    if fi:
                        name = fi.name
            if not name:
                name = "Food"

            # Prefer stored macro totals on MealLog; treat 0/None as missing and fall back to Nutrients once if needed
            protein = m.protein_g
            fat = m.fat_g
            carbs = m.carbs_g

            need_macros = (not protein) and (not fat) and (not carbs)
            if need_macros and (food is not None or m.food_id):
                try:
                    nutrients = None
                    if food is not None:
                        nutrients = getattr(food, "nutrients", None)
                    elif m.food_id:
                        nutrients = Nutrients.query.filter_by(food_id=m.food_id).first()
                    if nutrients is not None:
                        protein = nutrients.protein_g
                        fat = nutrients.fat_g
                        carbs = nutrients.carbs_g
                except Exception:
                    pass

            results.append({
                "id": m.id,
                "time": m.timestamp.strftime("%H:%M") if m.timestamp else "",
                "name": name or "Food",
                "meal_type": getattr(m, "meal_type", ""),
                "calories": float(m.total_calories or 0),
                "protein": float(protein or 0),
                "fat": float(fat or 0),
                "carbs": float(carbs or 0),
            })

        return {"meals": results}
    except Exception as e:
        return {"error": str(e)}, 500


@app.route("/api/food_ai_summary", methods=["POST"])
@login_required
def food_ai_summary():
    """AI + RAG analysis of today's meals and detection history."""
    try:
        today = datetime.utcnow().date()
        start_dt = datetime.combine(today, datetime.min.time())
        end_dt = datetime.combine(today, datetime.max.time())

        meals = MealLog.query.filter(
            MealLog.user_id == current_user.id,
            MealLog.timestamp >= start_dt,
            MealLog.timestamp <= end_dt,
        ).order_by(MealLog.timestamp.asc()).all()

        # Build a compact textual summary of meals
        meal_lines = []
        for m in meals:
            name = getattr(m, "food_name", None)
            try:
                if not name and getattr(m, "food", None):
                    name = m.food.name
            except Exception:
                pass

            meal_type = getattr(m, "meal_type", "meal")
            cals = round(float(m.total_calories or 0))
            meal_lines.append(f"- {meal_type}: {name or 'Food'} ~ {cals} kcal")

        meals_text = "\n".join(meal_lines) if meal_lines else "No meals logged today."

        # Also include latest calorie detection logs
        detections = CalorieDetectionLog.query.filter_by(
            user_id=current_user.id,
            date=today,
        ).order_by(CalorieDetectionLog.created_at.desc()).limit(3).all()

        detection_summaries = []
        for d in detections:
            try:
                items = json.loads(d.food_items) if d.food_items else []
            except Exception:
                items = []
            names = ", ".join(i.get("name", "food") for i in items)
            detection_summaries.append(
                f"Image detection (~{round(d.total_calories or 0)} kcal): {names}"
            )

        detection_text = "\n".join(detection_summaries) if detection_summaries else "No image-based detections today."

        # Build user context using up-to-date totals from MealLog (same as dashboard)
        progress = DailyProgress.query.filter_by(
            user_id=current_user.id,
            date=today,
        ).first()
        targets = DailyTargets.query.filter_by(
            user_id=current_user.id,
            date=today,
        ).first()

        consumed_calories_today = sum(float(m.total_calories or 0) for m in meals)

        user_context = {
            "date": today.isoformat(),
            "target_calories": getattr(targets, "target_calories", None),
            # Always use fresh sum from today's MealLog entries for analysis
            "consumed_calories": consumed_calories_today,
            "meals_logged": getattr(progress, "meals_logged", len(meals)),
        }

        # Use existing RAG helpers
        query = (
            "Analyze todays meal log, including frequency of foods, timing, and caloric balance. "
            "Explain how to take these foods in the correct way (timing, combinations), what to add to improve "
            "nutrition quality (protein, fiber, micronutrients), and what to reduce or adjust to decrease calories "
            "without harming satiety. Provide a clear, structured summary."
        )

        expanded_query = expand_query(query)
        retrieved_docs = advanced_retrieve_relevant_context(
            expanded_query,
            category="nutrition",
            limit=4,
            user_profile=user_context,
        )

        rag_prompt = advanced_rag_augmented_prompt(
            query,
            retrieved_docs,
            user_context=(
                f"Meals today:\n{meals_text}\n\n"
                f"Image detections:\n{detection_text}\n\n"
                f"Daily context: {user_context}"
            ),
        )

        response = openai_client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {
                    "role": "system",
                    "content": """You are a personal nutrition and fitness AI assistant.
Answer ONLY based on the context provided below.
If the context doesn't have enough info, say so.
Be specific and reference the user's personal data when available.

Context:
""" + rag_prompt
                },
                {"role": "user", "content": query}
            ],
            temperature=0.3,
            max_tokens=500
        )
        
        # Format sources with relevance scores if available
        formatted_sources = []
        for i, source in enumerate(retrieved_docs):
            if isinstance(source, dict):
                formatted_sources.append({
                    "title": source.get("title", "Knowledge Article"),
                    "category": source.get("category", ""),
                    "relevance_score": source.get("relevance_score", 0.85)
                })
        
        return jsonify({
            "answer": response.choices[0].message.content,
            "sources": formatted_sources,
            "personal_data_used": len(user_context) > 0
        })
    except Exception as e:
        print(f"Error in food_ai_summary: {e}")
        return {"error": str(e)}, 500


@app.route("/api/weekly_overview")
@login_required
def weekly_overview():
    """Return last 7 days calories/macros and frequent foods for weekly insights."""
    try:
        today = datetime.utcnow().date()
        start_date = today - timedelta(days=6)

        day_summaries = []

        for i in range(7):
            day = start_date + timedelta(days=i)
            # Aggregate per-day from MealLog
            rows = db.session.query(
                db.func.sum(MealLog.total_calories).label("calories"),
                db.func.sum(MealLog.protein_g).label("protein_g"),
                db.func.sum(MealLog.carbs_g).label("carbs_g"),
                db.func.sum(MealLog.fat_g).label("fat_g"),
            ).filter(
                MealLog.user_id == current_user.id,
                db.func.date(MealLog.timestamp) == day,
            ).first()

            calories = float(rows.calories or 0) if rows else 0.0
            protein = float(rows.protein_g or 0) if rows else 0.0
            carbs = float(rows.carbs_g or 0) if rows else 0.0
            fat = float(rows.fat_g or 0) if rows else 0.0

            targets = DailyTargets.query.filter_by(user_id=current_user.id, date=day).first()
            target_calories = getattr(targets, "target_calories", None)

            # Simple macro balance label
            macro_label = ""
            total_macros = protein + carbs + fat
            if total_macros > 0:
                p_share = protein * 4 / (calories or 1)
                c_share = carbs * 4 / (calories or 1)
                f_share = fat * 9 / (calories or 1)
                if p_share > 0.3:
                    macro_label = "High-protein"
                elif c_share > 0.55:
                    macro_label = "High-carb"
                elif f_share > 0.4:
                    macro_label = "High-fat"
                else:
                    macro_label = "Balanced"

            day_summaries.append({
                "date": day.isoformat(),
                "calories": round(calories),
                "protein_g": round(protein, 1),
                "carbs_g": round(carbs, 1),
                "fat_g": round(fat, 1),
                "target_calories": target_calories,
                "macro_label": macro_label,
            })

        # Frequent foods over last 7 days
        food_counts = (
            db.session.query(MealLog.food_id, db.func.count(MealLog.id))
            .filter(
                MealLog.user_id == current_user.id,
                db.func.date(MealLog.timestamp) >= start_date,
                db.func.date(MealLog.timestamp) <= today,
                MealLog.food_id.isnot(None),
            )
            .group_by(MealLog.food_id)
            .order_by(db.func.count(MealLog.id).desc())
            .limit(5)
            .all()
        )

        frequent_foods = []
        for food_id, count in food_counts:
            fi = FoodItem.query.get(food_id)
            if not fi:
                continue
            frequent_foods.append({
                "id": food_id,
                "name": fi.name,
                "brand": fi.brand,
                "count": int(count),
            })

        avg_calories = round(sum(d["calories"] for d in day_summaries) / 7) if day_summaries else 0

        return {
            "days": day_summaries,
            "frequent_foods": frequent_foods,
            "avg_calories": avg_calories,
        }
    except Exception as e:
        print(f"Error in weekly_overview: {e}")
        return {"error": str(e)}, 500


@app.route("/api/weekly_ai_summary", methods=["POST"])
@login_required
def weekly_ai_summary():
    """AI + RAG summary for the last 7 days (best/hardest day, patterns)."""
    try:
        today = datetime.utcnow().date()
        start_date = today - timedelta(days=6)

        meals = MealLog.query.filter(
            MealLog.user_id == current_user.id,
            db.func.date(MealLog.timestamp) >= start_date,
            db.func.date(MealLog.timestamp) <= today,
        ).order_by(MealLog.timestamp.asc()).all()

        # Per-day calories to identify best/hardest days
        per_day = {}
        for m in meals:
            d = m.timestamp.date() if m.timestamp else today
            per_day.setdefault(d, 0.0)
            per_day[d] += float(m.total_calories or 0)

        lines = []
        for day, cals in sorted(per_day.items()):
            lines.append(f"- {day.isoformat()}: ~{round(cals)} kcal")

        weekly_text = "\n".join(lines) if lines else "No meals logged in the last 7 days."

        # Frequent foods from overview helper
        overview = weekly_overview().get_json() if hasattr(weekly_overview(), "get_json") else None

        # Build user context string
        ctx = f"7-day caloric log:\n{weekly_text}\n\n"
        if overview and overview.get("frequent_foods"):
            food_names = ", ".join(f["name"] for f in overview["frequent_foods"])
            ctx += f"Most frequent foods: {food_names}\n\n"

        query = (
            "Analyze the last 7 days of this user's meals. Identify total and average calories, "
            "which days were best aligned with targets vs hardest (highest surplus or deficit), "
            "and describe macro balance patterns (high-carb, high-protein, etc.). Provide 3-5 concrete, "
            "personalized recommendations for the coming week."
        )

        expanded_query = expand_query(query)
        retrieved_docs = advanced_retrieve_relevant_context(
            expanded_query,
            category="nutrition",
            limit=4,
            user_profile=None,
        )

        rag_prompt = advanced_rag_augmented_prompt(
            query,
            retrieved_docs,
            user_context=ctx,
        )

        response = openai_client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You are an expert nutrition coach. Using the last 7 days of caloric data, "
                        "summarize performance and provide concise, actionable guidance."
                    ),
                },
                {"role": "user", "content": rag_prompt},
            ],
            max_tokens=900,
            temperature=0.7,
        )

        analysis = response.choices[0].message.content
        return {"analysis": analysis}
    except Exception as e:
        print(f"Error in weekly_ai_summary: {e}")
        return {"error": str(e)}, 500

@app.route("/api/daily_progress")
@login_required
def daily_progress():
    today = datetime.utcnow().date()
    
    # Get user's daily targets
    targets = DailyTargets.query.filter_by(
        user_id=current_user.id,
        date=today
    ).first()
    
    if not targets:
        # If no targets set for today, create default targets
        targets = DailyTargets(
            user_id=current_user.id,
            date=today,
            target_calories=2000,
            target_protein_g=150,
            target_carbs_g=250,
            target_fat_g=65
        )
        db.session.add(targets)
        db.session.commit()
    
    # Calculate consumed nutrition for today from MealLog per-meal totals
    consumed_row = db.session.query(
        db.func.sum(MealLog.total_calories).label('calories'),
        db.func.sum(MealLog.protein_g).label('protein_g'),
        db.func.sum(MealLog.carbs_g).label('carbs_g'),
        db.func.sum(MealLog.fat_g).label('fat_g'),
    ).filter(
        MealLog.user_id == current_user.id,
        db.func.date(MealLog.timestamp) == today
    ).first()
    
    consumed_calories = (consumed_row.calories or 0) if consumed_row else 0
    consumed_protein = (consumed_row.protein_g or 0) if consumed_row else 0
    consumed_carbs = (consumed_row.carbs_g or 0) if consumed_row else 0
    consumed_fat = (consumed_row.fat_g or 0) if consumed_row else 0
    
    # Calculate remaining values
    remaining_calories = max(0, (targets.target_calories or 0) - consumed_calories)
    remaining_protein = max(0, (targets.target_protein_g or 0) - consumed_protein)
    remaining_carbs = max(0, (targets.target_carbs_g or 0) - consumed_carbs)
    remaining_fat = max(0, (targets.target_fat_g or 0) - consumed_fat)
    
    # Calculate percentages
    calories_percent = min(100, (consumed_calories / (targets.target_calories or 1) * 100) if (targets.target_calories or 0) > 0 else 0)
    protein_percent = min(100, (consumed_protein / (targets.target_protein_g or 1) * 100) if (targets.target_protein_g or 0) > 0 else 0)
    carbs_percent = min(100, (consumed_carbs / (targets.target_carbs_g or 1) * 100) if (targets.target_carbs_g or 0) > 0 else 0)
    fat_percent = min(100, (consumed_fat / (targets.target_fat_g or 1) * 100) if (targets.target_fat_g or 0) > 0 else 0)
    
    return jsonify({
        'targets': {
            'calories': targets.target_calories,
            'protein': targets.target_protein_g,
            'carbs': targets.target_carbs_g,
            'fat': targets.target_fat_g
        },
        'consumed': {
            'calories': consumed_calories,
            'protein': consumed_protein,
            'carbs': consumed_carbs,
            'fat': consumed_fat
        },
        'remaining': {
            'calories': remaining_calories,
            'protein': remaining_protein,
            'carbs': remaining_carbs,
            'fat': remaining_fat
        },
        'percentages': {
            'calories': calories_percent,
            'protein': protein_percent,
            'carbs': carbs_percent,
            'fat': fat_percent
        }
    })

def get_today_detected_calories():
    """Get calories from today's dashboard detections"""
    try:
        today = datetime.now().date()
        
        # Get today's detections from database
        detections = CalorieDetectionLog.query.filter_by(
            user_id=current_user.id, 
            date=today
        ).all()
        
        total_detected = sum(detection.total_calories for detection in detections)
        return total_detected
        
    except Exception as e:
        print(f"Error getting detected calories: {e}")
        return 0

@app.route("/api/log_detected_foods_to_meals", methods=["POST"])
@login_required
def log_detected_foods_to_meals():
    """Log dashboard calorie detections to food logging meals"""
    try:
        today = datetime.now().date()
        
        # Get today's unlogged detections
        detections = CalorieDetectionLog.query.filter_by(
            user_id=current_user.id,
            date=today,
            logged_to_meals=False
        ).all()
        
        meals_logged = 0
        total_calories_logged = 0
        
        for detection in detections:
            try:
                # Parse food items from JSON
                food_items = json.loads(detection.food_items) if detection.food_items else []
                
                for food_item in food_items:
                    # Create a meal log entry for each detected food
                    meal = MealLog(
                        user_id=current_user.id,
                        food_name=food_item.get('name', 'Detected Food'),
                        brand=food_item.get('brand', 'AI Detection'),
                        quantity=food_item.get('quantity', 1),
                        portion_text=food_item.get('portion', '1 serving'),
                        total_calories=food_item.get('calories', 0),
                        protein_g=food_item.get('protein', 0),
                        fat_g=food_item.get('fat', 0),
                        carbs_g=food_item.get('carbs', 0),
                        photo_url="",
                        meal_type="snack"  # Default to snack for detected foods
                    )
                    db.session.add(meal)
                    meals_logged += 1
                    total_calories_logged += food_item.get('calories', 0)
                
                # Mark this detection as logged
                detection.logged_to_meals = True
                
            except Exception as e:
                print(f"Error logging detection {detection.id}: {e}")
                continue
        
        db.session.commit()
        
        return jsonify({
            'success': True,
            'meals_logged': meals_logged,
            'total_calories_logged': total_calories_logged,
            'message': f'Successfully logged {meals_logged} detected foods to meals'
        })
        
    except Exception as e:
        db.session.rollback()
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500
@app.route("/api/weekly_progress")
@login_required
def get_weekly_progress():
    """Get weekly nutrition progress history"""
    try:
        # Get last 7 days
        end_date = datetime.utcnow().date()
        start_date = end_date - timedelta(days=6)
        
        weekly_data = []
        
        for i in range(7):
            current_date = start_date + timedelta(days=i)
            
            # Get targets for this date
            targets = DailyTargets.query.filter_by(
                user_id=current_user.id,
                date=current_date
            ).first()
            
            # Get progress for this date
            progress = DailyProgress.query.filter_by(
                user_id=current_user.id,
                date=current_date
            ).first()
            
            weekly_data.append({
                "date": current_date.isoformat(),
                "day_name": current_date.strftime('%A'),
                "targets": {
                    "calories": targets.target_calories if targets else 2000,
                    "protein_g": targets.target_protein_g if targets else 50,
                    "fat_g": targets.target_fat_g if targets else 65,
                    "carbs_g": targets.target_carbs_g if targets else 250
                },
                "consumed": {
                    "calories": progress.consumed_calories if progress else 0,
                    "protein_g": progress.consumed_protein_g if progress else 0,
                    "fat_g": progress.consumed_fat_g if progress else 0,
                    "carbs_g": progress.consumed_carbs_g if progress else 0
                },
                "meals_logged": progress.meals_logged if progress else 0
            })
        
        return {"weekly_data": weekly_data}
        
    except Exception as e:
        return {"error": str(e)}

@app.route("/api/detect_food_from_image", methods=["POST"])
@login_required
def detect_food_from_image():
    """Detect food and calories from uploaded image"""
    try:
        if 'image' not in request.files:
            return {"error": "No image file provided"}, 400
        
        file = request.files['image']
        if file.filename == '':
            return {"error": "No image file selected"}, 400
        
        # Save uploaded file temporarily
        with tempfile.NamedTemporaryFile(delete=False, suffix='.jpg') as tmp_file:
            file.save(tmp_file.name)
            image_path = tmp_file.name
        
        try:
            # Use existing calorie detection
            detection_result = get_calories_from_image(image_path)
            
            if 'error' in detection_result:
                return {"error": "Failed to detect food: " + detection_result['error']}, 500
            
            # Format results for frontend
            result = {
                "success": True,
                "reasoning": detection_result.get('reasoning', ''),
                "food_items": detection_result.get('food_items', []),
                "nutrition": detection_result.get('nutrition', {}),
                "total_calories": detection_result.get('total', 0)
            }
            
            return result
            
        finally:
            # Clean up temporary file
            if os.path.exists(image_path):
                os.unlink(image_path)
        
    except Exception as e:
        return {"error": str(e)}

@app.route("/api/log_detected_food", methods=["POST"])
@login_required
def log_detected_food():
    """Log AI-detected food items to the database"""
    try:
        data = request.get_json()
        food_items = data.get('food_items', [])
        meal_type = data.get('meal_type', 'snack')
        
        if not food_items:
            return {"error": "No food items to log"}, 400
        
        logged_items = []
        total_nutrition = {
            'calories': 0,
            'protein': 0,
            'fat': 0,
            'carbs': 0
        }
        
        for item in food_items:
            # Create or find food item in database
            food = FoodItem.query.filter_by(name=item['name']).first()
            if not food:
                # Create new food item
                food = FoodItem(
                    source='ai_detected',
                    name=item['name'],
                    brand='AI Detected',
                    serving_qty=1,
                    serving_unit='serving'
                )
                db.session.add(food)
                db.session.flush()  # Get ID without committing
                
                # Create nutrients (estimated from calories)
                estimated_macros = estimate_macros_from_calories(item['calories'])
                nutrients = Nutrients(
                    food_id=food.id,
                    calories=item['calories'],
                    protein_g=estimated_macros['protein'],
                    fat_g=estimated_macros['fat'],
                    carbs_g=estimated_macros['carbs'],
                    fiber_g=estimated_macros['fiber']
                )
                db.session.add(nutrients)
            
            # Log the meal
            meal_log = MealLog(
                user_id=current_user.id,
                food_id=food.id,
                quantity=1,
                portion_text="1 serving (AI detected)",
                total_calories=item['calories'],
                meal_type=meal_type
            )
            
            db.session.add(meal_log)
            
            # Add to totals
            total_nutrition['calories'] += item['calories']
            if food.nutrients:
                total_nutrition['protein'] += food.nutrients.protein_g
                total_nutrition['fat'] += food.nutrients.fat_g
                total_nutrition['carbs'] += food.nutrients.carbs_g
            
            logged_items.append({
                'name': item['name'],
                'calories': item['calories'],
                'confidence': item.get('confidence', 0)
            })
        
        # Update daily progress
        today = datetime.utcnow().date()
        progress = DailyProgress.query.filter_by(
            user_id=current_user.id,
            date=today
        ).first()
        
        if not progress:
            progress = DailyProgress(
                user_id=current_user.id,
                date=today
            )
            db.session.add(progress)
        
        # Update consumed values
        progress.consumed_calories += total_nutrition['calories']
        progress.consumed_protein_g += total_nutrition['protein']
        progress.consumed_fat_g += total_nutrition['fat']
        progress.consumed_carbs_g += total_nutrition['carbs']
        progress.meals_logged += len(logged_items)
        progress.last_updated = datetime.utcnow()
        
        db.session.commit()
        
        return {
            "success": True,
            "logged_items": logged_items,
            "total_nutrition": total_nutrition,
            "meals_logged": len(logged_items)
        }
        
    except Exception as e:
        db.session.rollback()
        return {"error": str(e)}

def estimate_macros_from_calories(calories):
    """Estimate macronutrients from total calories using typical ratios"""
    # Typical ratio: 30% protein, 25% fat, 45% carbs
    protein_calories = calories * 0.30
    fat_calories = calories * 0.25
    carb_calories = calories * 0.45
    
    return {
        'protein': protein_calories / 4,  # 4 cal per gram
        'fat': fat_calories / 9,          # 9 cal per gram
        'carbs': carb_calories / 4,       # 4 cal per gram
        'fiber': max(2, calories * 0.01)  # Estimate fiber
    }

if __name__ == "__main__":
    with app.app_context():
        db.create_all()
        # Initialize knowledge base
        initialize_knowledge_base()
        
        # Lightweight schema guard for SQLite upgrades (adds 'name' to profile if missing)
        try:
            engine = db.engine
            if engine.url.drivername.startswith("sqlite"):
                insp = db.inspect(engine)
                cols = [c['name'] for c in insp.get_columns('profile')]
                if 'name' not in cols:
                    with engine.begin() as conn:
                        conn.exec_driver_sql("ALTER TABLE profile ADD COLUMN name VARCHAR(255)")
        except Exception:
            # Ignore to avoid blocking startup; errors will surface during requests
            pass

# ===== HARDWARE INTEGRATION ENDPOINTS =====

@app.route("/api/test", methods=["POST"])
def test_endpoint():
    """Test endpoint for ESP32 connectivity"""
    data = request.get_json()
    print(f"🔗 ESP32 Test: {data}")
    return {"status": "success", "message": "ESP32 connected successfully", "received": data}

@app.route("/api/device/register", methods=["POST"])
@login_required
def register_device():
    """Register new ESP32 device"""
    data = request.get_json()
    if not data or 'device_id' not in data:
        return {"error": "device_id is required"}, 400
    
    # Check if device already exists
    existing_device = Device.query.filter_by(device_id=data['device_id']).first()
    if existing_device:
        if existing_device.user_id != current_user.id:
            return {"error": "Device already registered by another user"}, 400
        # Update last seen
        existing_device.last_seen = datetime.utcnow()
        existing_device.is_active = True
        db.session.commit()
        return {"success": True, "message": "Device reconnected", "device_id": existing_device.device_id}
    
    # Create new device
    device = Device(
        user_id=current_user.id,
        device_id=data['device_id'],
        device_name=data.get('device_name', 'ESP32 Health Monitor'),
        device_type=data.get('device_type', 'health_monitor'),
        firmware_version=data.get('firmware_version', '1.0')
    )
    db.session.add(device)
    db.session.commit()
    
    print(f"📱 New device registered: {device.device_id} for user {current_user.email}")
    return {"success": True, "message": "Device registered successfully", "device_id": device.device_id}

@app.route("/api/sensor/heart_rate", methods=["POST"])
@login_required
def receive_heart_rate():
    """ESP32 sends heart rate data here"""
    data = request.get_json()
    if not data or 'bpm' not in data:
        return {"error": "bpm is required"}, 400
    
    log = HeartRateLog(
        user_id=current_user.id,
        device_id=data.get('device_id'),
        bpm=data['bpm'],
        confidence=data.get('confidence', 0.95),
        activity_context=data.get('activity_context', 'rest')
    )
    db.session.add(log)
    db.session.commit()
    
    print(f"❤️ Heart rate logged: {data['bpm']} BPM for user {current_user.email}")
    
    # Alert if abnormal
    if data['bpm'] > 120 or data['bpm'] < 50:
        alert = HealthAlert(
            user_id=current_user.id,
            alert_type='high_heart_rate' if data['bpm'] > 120 else 'low_heart_rate',
            severity='medium' if data['bpm'] > 100 or data['bpm'] < 60 else 'high',
            message=f"Abnormal heart rate detected: {data['bpm']} BPM",
            sensor_data=json.dumps({"bpm": data['bpm'], "timestamp": datetime.utcnow().isoformat()})
        )
        db.session.add(alert)
        db.session.commit()
        print(f"⚠️ Health alert created for abnormal heart rate: {data['bpm']} BPM")
    
    return {"success": True, "received": data['bpm']}

@app.route("/api/sensor/spo2", methods=["POST"])
@login_required
def receive_spo2():
    """ESP32 sends SpO2 data here"""
    data = request.get_json()
    if not data or 'spo2' not in data:
        return {"error": "spo2 is required"}, 400
    
    log = SpO2Log(
        user_id=current_user.id,
        device_id=data.get('device_id'),
        spo2_percentage=data['spo2'],
        bpm=data.get('bpm'),
        confidence=data.get('confidence')
    )
    db.session.add(log)
    db.session.commit()
    
    print(f"💨 SpO2 logged: {data['spo2']}% for user {current_user.email}")
    
    # Critical alert for low SpO2
    if data['spo2'] < 90:
        alert = HealthAlert(
            user_id=current_user.id,
            alert_type='low_spo2',
            severity='critical',
            message=f"Low blood oxygen detected: {data['spo2']}% - Seek medical attention!",
            sensor_data=json.dumps({"spo2": data['spo2'], "timestamp": datetime.utcnow().isoformat()})
        )
        db.session.add(alert)
        db.session.commit()
        print(f"🚨 CRITICAL alert: Low SpO2 {data['spo2']}% for user {current_user.email}")
    
    return {"success": True}

@app.route("/api/sensor/motion", methods=["POST"])
@login_required
def receive_motion():
    """ESP32 sends steps and activity data"""
    data = request.get_json()
    if not data:
        return {"error": "No data provided"}, 400
    
    log = MotionLog(
        user_id=current_user.id,
        device_id=data.get('device_id'),
        steps=data.get('steps', 0),
        calories_burned=data.get('calories', 0),
        activity_type=data.get('activity', 'unknown'),
        intensity=data.get('intensity'),
        duration_seconds=data.get('duration')
    )
    db.session.add(log)
    db.session.commit()
    
    print(f"🏃 Motion logged: {data.get('steps', 0)} steps, {data.get('activity', 'unknown')} for user {current_user.email}")
    
    return {"success": True}

@app.route("/api/sensor/food_weight", methods=["POST"])
@login_required
def receive_food_weight():
    """ESP32 sends food weight from load cell"""
    data = request.get_json()
    if not data or 'weight_grams' not in data:
        return {"error": "weight_grams is required"}, 400
    
    weight = data.get('weight_grams', 0)
    print(f"⚖️ Food weight logged: {weight}g for user {current_user.email}")
    
    return {
        "success": True, 
        "weight": weight,
        "message": f"Food weight recorded: {weight}g",
        "suggestion": "Now take a photo for calorie analysis"
    }

@app.route("/api/devices", methods=["GET"])
@login_required
def get_devices():
    """Get all registered devices for current user"""
    devices = Device.query.filter_by(user_id=current_user.id).all()
    return {
        "devices": [
            {
                "device_id": device.device_id,
                "device_name": device.device_name,
                "device_type": device.device_type,
                "battery_level": device.battery_level,
                "last_seen": device.last_seen.isoformat(),
                "is_active": device.is_active
            }
            for device in devices
        ]
    }

@app.route("/api/sensor_data/latest", methods=["GET"])
@login_required
def get_latest_sensor_data():
    """Get latest sensor readings for dashboard"""
    latest_hr = HeartRateLog.query.filter_by(user_id=current_user.id).order_by(HeartRateLog.timestamp.desc()).first()
    latest_spo2 = SpO2Log.query.filter_by(user_id=current_user.id).order_by(SpO2Log.timestamp.desc()).first()
    latest_motion = MotionLog.query.filter_by(user_id=current_user.id).order_by(MotionLog.timestamp.desc()).first()
    
    return {
        "heart_rate": {
            "bpm": latest_hr.bpm if latest_hr else None,
            "timestamp": latest_hr.timestamp.isoformat() if latest_hr else None
        },
        "spo2": {
            "percentage": latest_spo2.spo2_percentage if latest_spo2 else None,
            "timestamp": latest_spo2.timestamp.isoformat() if latest_spo2 else None
        },
        "motion": {
            "steps": latest_motion.steps if latest_motion else None,
            "activity": latest_motion.activity_type if latest_motion else None,
            "timestamp": latest_motion.timestamp.isoformat() if latest_motion else None
        }
    }

@app.route("/api/health_alerts", methods=["GET"])
@login_required
def get_health_alerts():
    """Get unacknowledged health alerts"""
    alerts = HealthAlert.query.filter_by(user_id=current_user.id, is_acknowledged=False).order_by(HealthAlert.created_at.desc()).limit(10).all()
    
    return {
        "alerts": [
            {
                "id": alert.id,
                "type": alert.alert_type,
                "severity": alert.severity,
                "message": alert.message,
                "created_at": alert.created_at.isoformat()
            }
            for alert in alerts
        ]
    }

@app.route("/api/health_alerts/<int:alert_id>/acknowledge", methods=["POST"])
@login_required
def acknowledge_alert(alert_id):
    """Acknowledge a health alert"""
    alert = HealthAlert.query.filter_by(id=alert_id, user_id=current_user.id).first()
    if not alert:
        return {"error": "Alert not found"}, 404
    
    alert.is_acknowledged = True
    alert.acknowledged_at = datetime.utcnow()
    db.session.commit()
    
    return {"success": True, "message": "Alert acknowledged"}

# ===== CHART DATA ENDPOINTS =====

@app.route("/api/charts/weekly_calories")
@login_required
def weekly_calories_chart():
    """Get weekly calorie trend data for dashboard chart"""
    try:
        # Get last 7 days of data
        end_date = datetime.utcnow().date()
        start_date = end_date - timedelta(days=6)
        
        weekly_data = []
        for i in range(7):
            current_date = start_date + timedelta(days=i)
            day_logs = MealLog.query.filter(
                MealLog.user_id == current_user.id,
                MealLog.timestamp >= datetime.combine(current_date, datetime.min.time()),
                MealLog.timestamp < datetime.combine(current_date + timedelta(days=1), datetime.min.time())
            ).all()
            
            total_calories = sum(log.total_calories or 0 for log in day_logs)
            weekly_data.append({
                "date": current_date.strftime("%Y-%m-%d"),
                "day": current_date.strftime("%a"),
                "calories": total_calories
            })
        
        return {"data": weekly_data}
    except Exception as e:
        print(f"Error getting weekly calories: {e}")
        return {"error": str(e)}, 500

@app.route("/api/charts/macronutrient_distribution")
@login_required
def macronutrient_distribution_chart():
    """Get macronutrient distribution data for dashboard chart"""
    try:
        # Get today's data
        today = datetime.utcnow().date()
        today_logs = MealLog.query.filter(
            MealLog.user_id == current_user.id,
            MealLog.timestamp >= datetime.combine(today, datetime.min.time()),
            MealLog.timestamp < datetime.combine(today + timedelta(days=1), datetime.min.time())
        ).all()
        
        total_protein = sum(log.protein_g or 0 for log in today_logs)
        total_carbs = sum(log.carbs_g or 0 for log in today_logs)
        total_fat = sum(log.fat_g or 0 for log in today_logs)
        
        # Convert to calories
        protein_calories = total_protein * 4
        carbs_calories = total_carbs * 4
        fat_calories = total_fat * 9
        total_macro_calories = protein_calories + carbs_calories + fat_calories
        
        if total_macro_calories > 0:
            protein_percentage = (protein_calories / total_macro_calories) * 100
            carbs_percentage = (carbs_calories / total_macro_calories) * 100
            fat_percentage = (fat_calories / total_macro_calories) * 100
        else:
            protein_percentage = carbs_percentage = fat_percentage = 0
        
        return {
            "data": {
                "protein": {
                    "grams": round(total_protein, 1),
                    "calories": round(protein_calories),
                    "percentage": round(protein_percentage, 1)
                },
                "carbs": {
                    "grams": round(total_carbs, 1),
                    "calories": round(carbs_calories),
                    "percentage": round(carbs_percentage, 1)
                },
                "fat": {
                    "grams": round(total_fat, 1),
                    "calories": round(fat_calories),
                    "percentage": round(fat_percentage, 1)
                },
                "total_calories": round(total_macro_calories)
            }
        }
    except Exception as e:
        print(f"Error getting macro distribution: {e}")
        return {"error": str(e)}, 500

@app.route("/api/charts/ai_insights")
@login_required
def ai_chart_insights():
    """Generate AI-powered insights for charts using OpenAI"""
    try:
        # Get user's recent nutrition data
        end_date = datetime.utcnow().date()
        start_date = end_date - timedelta(days=7)
        
        recent_logs = MealLog.query.filter(
            MealLog.user_id == current_user.id,
            MealLog.timestamp >= datetime.combine(start_date, datetime.min.time()),
            MealLog.timestamp < datetime.combine(end_date + timedelta(days=1), datetime.min.time())
        ).all()
        
        if not recent_logs:
            return {"insights": "No nutrition data available for analysis."}
        
        # Calculate weekly averages and trends
        daily_totals = {}
        for log in recent_logs:
            date = log.timestamp.date().strftime("%Y-%m-%d")
            if date not in daily_totals:
                daily_totals[date] = {"calories": 0, "protein": 0, "carbs": 0, "fat": 0}
            
            daily_totals[date]["calories"] += log.total_calories or 0
            daily_totals[date]["protein"] += log.protein_g or 0
            daily_totals[date]["carbs"] += log.carbs_g or 0
            daily_totals[date]["fat"] += log.fat_g or 0
        
        avg_calories = sum(day["calories"] for day in daily_totals.values()) / len(daily_totals)
        avg_protein = sum(day["protein"] for day in daily_totals.values()) / len(daily_totals)
        avg_carbs = sum(day["carbs"] for day in daily_totals.values()) / len(daily_totals)
        avg_fat = sum(day["fat"] for day in daily_totals.values()) / len(daily_totals)
        
        # Get user profile for context
        profile = current_user.profile
        user_context = ""
        if profile:
            user_context = f"User profile: {profile.age}y {profile.sex}, {profile.weight_kg}kg, {profile.height_cm}cm, activity level: {profile.activity_level}"
        
        # Generate AI insights
        prompt = f"""
        Analyze this user's weekly nutrition data and provide insights:
        
        {user_context}
        
        Weekly averages:
        - Calories: {avg_calories:.0f} kcal/day
        - Protein: {avg_protein:.1f}g/day  
        - Carbs: {avg_carbs:.1f}g/day
        - Fat: {avg_fat:.1f}g/day
        
        Provide 3-4 specific, actionable insights about:
        1. Calorie intake patterns
        2. Macronutrient balance
        3. Recommendations for improvement
        4. Health implications
        
        Keep it concise and encouraging. Format as bullet points.
        """
        
        response = openai_client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": "You are a nutrition expert providing data-driven insights. Be specific, encouraging, and actionable."},
                {"role": "user", "content": prompt}
            ],
            max_tokens=300,
            temperature=0.7
        )
        
        insights = response.choices[0].message.content
        
        return {"insights": insights}
        
    except Exception as e:
        print(f"Error generating AI insights: {e}")
        return {"insights": "Unable to generate insights at this time."}


# ============================================================
# RAG (Retrieval-Augmented Generation) System
# ============================================================
# ============================================================
# RAG (Retrieval-Augmented Generation) System — COMPLETE
# Replace lines 2938–3097 in server.py with this entire block
# ============================================================

# ── ChromaDB init ────────────────────────────────────────────
chroma_client = chromadb.PersistentClient(path="./chroma_db")

# ── Embedding helper ─────────────────────────────────────────
def get_embedding(text: str) -> list:
    """Embed text with text-embedding-3-small (1536-dim, matches your DB)."""
    response = openai_client.embeddings.create(
        input=text[:8000],           # safety truncation
        model="text-embedding-3-small"
    )
    return response.data[0].embedding


# ── User-history ingestion ───────────────────────────────────

def ingest_user_meal_log(user_id: int, meal_log_obj) -> None:
    """
    Ingest a MealLog ORM object into the 'user_history' ChromaDB collection.
    Call this immediately after db.session.commit() in any meal-save route.

    Usage in server.py:
        db.session.add(meal_log)
        db.session.commit()
        ingest_user_meal_log(current_user.id, meal_log)
    """
    try:
        col = chroma_client.get_or_create_collection("user_history")

        food_name = "Unknown food"
        if meal_log_obj.food_id:
            food = FoodItem.query.get(meal_log_obj.food_id)
            if food:
                food_name = food.name

        date_str = meal_log_obj.timestamp.strftime("%Y-%m-%d") if meal_log_obj.timestamp else "unknown date"
        meal_type = meal_log_obj.meal_type or "meal"

        doc_text = (
            f"Meal logged on {date_str}: {food_name}\n"
            f"Meal type: {meal_type}\n"
            f"Calories: {meal_log_obj.total_calories or 0:.0f} kcal | "
            f"Protein: {meal_log_obj.protein_g or 0:.1f}g | "
            f"Carbs: {meal_log_obj.carbs_g or 0:.1f}g | "
            f"Fat: {meal_log_obj.fat_g or 0:.1f}g"
        )

        doc_id = f"meal_{user_id}_{meal_log_obj.id}"

        # Avoid duplicate ingestion
        existing = col.get(ids=[doc_id])
        if existing and existing["ids"]:
            return

        col.add(
            documents=[doc_text],
            metadatas=[{
                "user_id": str(user_id),
                "type": "meal",
                "date": date_str,
                "meal_type": meal_type,
                "food_name": food_name,
            }],
            ids=[doc_id],
            embeddings=[get_embedding(doc_text)],
        )
        print(f"[RAG] Ingested meal {doc_id} for user {user_id}")
    except Exception as e:
        print(f"[RAG] Error ingesting meal log: {e}")


def ingest_user_workout(user_id: int, workout_set_obj) -> None:
    """
    Ingest a WorkoutSet ORM object into the 'user_history' ChromaDB collection.
    Call this immediately after db.session.commit() in modify_workout_set().

    Usage in server.py (in modify_workout_set after the create commit):
        db.session.add(s)
        db.session.commit()
        ingest_user_workout(current_user.id, s)
    """
    try:
        col = chroma_client.get_or_create_collection("user_history")

        # Resolve session date
        session = WorkoutSession.query.get(workout_set_obj.session_id)
        date_str = session.date.strftime("%Y-%m-%d") if session and session.date else "unknown date"

        doc_text = (
            f"Workout logged on {date_str}: {workout_set_obj.exercise_name}\n"
            f"Muscle group: {workout_set_obj.muscle_group or 'N/A'}\n"
            f"Sets: {workout_set_obj.sets} | Reps: {workout_set_obj.reps} | "
            f"Weight: {workout_set_obj.weight:.1f}kg"
            + (f" | RPE: {workout_set_obj.rpe}" if workout_set_obj.rpe else "")
        )

        doc_id = f"workout_{user_id}_{workout_set_obj.id}"

        existing = col.get(ids=[doc_id])
        if existing and existing["ids"]:
            return

        col.add(
            documents=[doc_text],
            metadatas=[{
                "user_id": str(user_id),
                "type": "workout",
                "date": date_str,
                "exercise": workout_set_obj.exercise_name,
                "muscle_group": workout_set_obj.muscle_group or "",
            }],
            ids=[doc_id],
            embeddings=[get_embedding(doc_text)],
        )
        print(f"[RAG] Ingested workout {doc_id} for user {user_id}")
    except Exception as e:
        print(f"[RAG] Error ingesting workout: {e}")


def ingest_user_profile(user_id: int, profile_obj) -> None:
    """
    Ingest/update a user Profile into ChromaDB so the AI knows their biometrics.
    Call after every profile save.
    """
    try:
        col = chroma_client.get_or_create_collection("user_history")

        doc_text = (
            f"User profile for user {user_id}:\n"
            f"Age: {profile_obj.age or 'N/A'} | Sex: {profile_obj.sex or 'N/A'}\n"
            f"Height: {profile_obj.height_cm or 'N/A'} cm | Weight: {profile_obj.weight_kg or 'N/A'} kg\n"
            f"Activity level: {profile_obj.activity_level or 'N/A'}\n"
            f"Exercise level: {profile_obj.exercise_level or 'N/A'}\n"
            f"Work activity: {profile_obj.work_activity_level or 'N/A'}"
        )

        doc_id = f"profile_{user_id}"

        # Always upsert profile (it can change)
        try:
            col.update(
                ids=[doc_id],
                documents=[doc_text],
                metadatas=[{"user_id": str(user_id), "type": "profile"}],
                embeddings=[get_embedding(doc_text)],
            )
        except Exception:
            col.add(
                documents=[doc_text],
                metadatas=[{"user_id": str(user_id), "type": "profile"}],
                ids=[doc_id],
                embeddings=[get_embedding(doc_text)],
            )
        print(f"[RAG] Upserted profile for user {user_id}")
    except Exception as e:
        print(f"[RAG] Error ingesting profile: {e}")


# ── Backfill existing data ────────────────────────────────────

@app.route("/api/rag/backfill", methods=["POST"])
@login_required
def rag_backfill():
    """
    One-time endpoint to backfill all existing meals and workouts
    for the current user into ChromaDB.
    Call once from the browser console:
        fetch('/api/rag/backfill', {method:'POST'})
    """
    user_id = current_user.id
    meals_done = 0
    workouts_done = 0
    errors = 0

    # Backfill meals (last 90 days)
    cutoff = datetime.utcnow() - timedelta(days=90)
    meals = MealLog.query.filter(
        MealLog.user_id == user_id,
        MealLog.timestamp >= cutoff
    ).all()

    for meal in meals:
        try:
            ingest_user_meal_log(user_id, meal)
            meals_done += 1
        except Exception:
            errors += 1

    # Backfill workouts
    sessions = WorkoutSession.query.filter_by(user_id=user_id).all()
    for session in sessions:
        for ws in session.sets:
            try:
                ingest_user_workout(user_id, ws)
                workouts_done += 1
            except Exception:
                errors += 1

    # Backfill profile
    if current_user.profile:
        try:
            ingest_user_profile(user_id, current_user.profile)
        except Exception:
            errors += 1

    return jsonify({
        "success": True,
        "meals_ingested": meals_done,
        "workouts_ingested": workouts_done,
        "errors": errors,
        "message": f"Backfilled {meals_done} meals and {workouts_done} workouts into RAG."
    })


# ── Main RAG query endpoint ──────────────────────────────────

# ══════════════════════════════════════════════════════════════
# PATCH: In server.py, replace ONLY the rag_query() function
# (starting at @app.route("/rag_query", ...) around line 2953)
# with this version. Everything else stays the same.
# ══════════════════════════════════════════════════════════════

@app.route("/rag_query", methods=["POST"])
@login_required
def rag_query():
    data = request.get_json() or {}
    user_question = (data.get("question") or "").strip()
    session_id    = data.get("session_id", f"session_{current_user.id}_{int(datetime.utcnow().timestamp())}")
    mode          = data.get("mode", "chat")
    # The frontend sends a pre-built system prompt per mode; fall back to default
    mode_system   = data.get("mode_system", "")

    if not user_question:
        return jsonify({"error": "No question provided"}), 400

    try:
        # 1. Embed question
        query_embedding = get_embedding(user_question)

        # 2. Knowledge base search
        knowledge_chunks, sources = [], []
        try:
            kb_col = chroma_client.get_collection("nutrition_knowledge")
            kb_res = kb_col.query(
                query_embeddings=[query_embedding],
                n_results=3,
                include=["documents", "metadatas", "distances"],
            )
            for i, doc in enumerate(kb_res["documents"][0]):
                meta     = kb_res["metadatas"][0][i]
                distance = kb_res["distances"][0][i]
                knowledge_chunks.append(doc)
                sources.append({
                    "title":           meta.get("title", "Knowledge Article"),
                    "category":        meta.get("category", ""),
                    "tags":            meta.get("tags", ""),
                    "relevance_score": round(1 - distance, 3),
                })
        except Exception as e:
            print(f"[RAG] KB search error: {e}")

        # 3. Personal history search
        user_chunks = []
        personal_data_used = False
        try:
            user_col = chroma_client.get_or_create_collection("user_history")
            if user_col.count() > 0:
                u_res = user_col.query(
                    query_embeddings=[query_embedding],
                    n_results=5,
                    where={"user_id": str(current_user.id)},
                    include=["documents", "metadatas"],
                )
                user_chunks = u_res["documents"][0]
                personal_data_used = len(user_chunks) > 0
        except Exception as e:
            print(f"[RAG] User history error: {e}")

        # 4. User profile context
        profile_ctx = ""
        profile = current_user.profile
        if profile:
            bmr_tdee = calculate_bmr_tdee(profile)
            profile_ctx = (
                f"User: {profile.age or '?'}y {profile.sex or '?'}, "
                f"{profile.weight_kg or '?'}kg, {profile.height_cm or '?'}cm, "
                f"activity={profile.activity_level or 'unknown'}, "
                f"exercise level={profile.exercise_level or 'unknown'}. "
                f"TDEE≈{bmr_tdee.get('tdee','N/A')} kcal/day."
            )

        # 5. Build context string
        kb_section = "\n\n".join(
            f"[KB-{i+1}] {sources[i]['title']}\n{chunk}"
            for i, chunk in enumerate(knowledge_chunks)
        ) if knowledge_chunks else "No relevant knowledge base articles found."

        history_section = "\n\n".join(user_chunks) if user_chunks else (
            "No personal history found. Encourage the user to log meals and workouts."
        )

        # 6. System prompt — use mode-specific prompt from frontend, augmented with context
        base_system = mode_system or (
            "You are NutriAI, a personal nutrition and fitness assistant. "
            "Use ONLY the context below. Cite knowledge base as [KB-N]. Be specific and actionable."
        )

        full_system = f"""{base_system}

USER PROFILE:
{profile_ctx or "No profile data available."}

RETRIEVED KNOWLEDGE BASE:
{kb_section}

USER'S PERSONAL HISTORY (meals, workouts):
{history_section}"""

        # 7. GPT-4o-mini completion
        completion = openai_client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system",  "content": full_system},
                {"role": "user",    "content": user_question},
            ],
            temperature=0.3,
            max_tokens=700,
        )
        answer = completion.choices[0].message.content

        # 8. Save to RAGChatHistory
        try:
            db.session.add(RAGChatHistory(
                user_id=current_user.id, session_id=session_id,
                message_type="user", content=user_question,
            ))
            db.session.add(RAGChatHistory(
                user_id=current_user.id, session_id=session_id,
                message_type="assistant", content=answer,
                retrieved_documents=json.dumps([s["title"] for s in sources]),
            ))
            db.session.commit()
        except Exception as e:
            print(f"[RAG] History save error: {e}")

        return jsonify({
            "answer":             answer,
            "sources":            sources,
            "session_id":         session_id,
            "personal_data_used": personal_data_used,
            "mode":               mode,
        })

    except Exception as e:
        print(f"[RAG] Query error: {e}")
        return jsonify({
            "error":  "Failed to process your question. Please try again.",
            "answer": "I'm having trouble right now. Please try again in a moment.",
        }), 500


@app.route("/rag_chat")
@login_required
def rag_chat():
    """Render the RAG chat page."""
    return render_template("rag_chat.html")


@app.route("/api/rag/history")
@login_required
def rag_history():
    """Return last 20 messages for the current user."""
    msgs = RAGChatHistory.query.filter_by(
        user_id=current_user.id
    ).order_by(RAGChatHistory.timestamp.desc()).limit(20).all()

    return jsonify([{
        "type": m.message_type,
        "content": m.content,
        "timestamp": m.timestamp.isoformat(),
        "sources": json.loads(m.retrieved_documents) if m.retrieved_documents else [],
    } for m in reversed(msgs)])


if __name__ == "__main__":
    app.run(debug=True, host='0.0.0.0', port=5002)

