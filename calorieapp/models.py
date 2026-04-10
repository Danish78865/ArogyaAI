import os
from datetime import datetime
from flask_sqlalchemy import SQLAlchemy
from werkzeug.security import generate_password_hash, check_password_hash

# SQLAlchemy instance (initialized in server.py)
db = SQLAlchemy()

class User(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    email = db.Column(db.String(255), unique=True, nullable=False)
    password_hash = db.Column(db.String(255), nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    profile = db.relationship('Profile', backref='user', uselist=False)

    def set_password(self, password: str):
        self.password_hash = generate_password_hash(password)

    def check_password(self, password: str) -> bool:
        return check_password_hash(self.password_hash, password)

    # Flask-Login helpers
    @property
    def is_authenticated(self):
        return True

    @property
    def is_active(self):
        return True

    @property
    def is_anonymous(self):
        return False

    def get_id(self):
        return str(self.id)

class Profile(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    name = db.Column(db.String(255))
    height_cm = db.Column(db.Float)  # centimeters
    weight_kg = db.Column(db.Float)  # kilograms
    age = db.Column(db.Integer)
    sex = db.Column(db.String(10))  # male/female
    activity_level = db.Column(db.String(20))  # sedentary, light, moderate, active, athlete
    unit_system = db.Column(db.String(10), default='metric')  # metric or imperial
    waist_cm = db.Column(db.Float)  # waist circumference in centimeters
    neck_cm = db.Column(db.Float)  # neck circumference in centimeters
    exercise_level = db.Column(db.String(20))  # beginner, intermediate, advanced
    work_activity_level = db.Column(db.String(20))  # desk_job, light_work, active_work, physical_work

class FoodItem(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    source = db.Column(db.String(50))  # api/usda/custom
    name = db.Column(db.String(255), nullable=False)
    brand = db.Column(db.String(255))
    barcode = db.Column(db.String(64), index=True)
    serving_qty = db.Column(db.Float)
    serving_unit = db.Column(db.String(50))

class Nutrients(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    food_id = db.Column(db.Integer, db.ForeignKey('food_item.id'), nullable=False)
    calories = db.Column(db.Float)
    protein_g = db.Column(db.Float)
    fat_g = db.Column(db.Float)
    carbs_g = db.Column(db.Float)
    fiber_g = db.Column(db.Float)
    sugar_g = db.Column(db.Float)
    sodium_mg = db.Column(db.Float)
    vitamin_c_mg = db.Column(db.Float)
    iron_mg = db.Column(db.Float)

class MealLog(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    food_id = db.Column(db.Integer, db.ForeignKey('food_item.id'))
    timestamp = db.Column(db.DateTime, default=datetime.utcnow, index=True)
    quantity = db.Column(db.Float, default=1.0)
    portion_text = db.Column(db.String(100))
    photo_url = db.Column(db.String(512))
    total_calories = db.Column(db.Float)
    meal_type = db.Column(db.String(50))  # breakfast, lunch, dinner, snack, extra, etc.
    protein_g = db.Column(db.Float, default=0.0)
    fat_g = db.Column(db.Float, default=0.0)
    carbs_g = db.Column(db.Float, default=0.0)

class KnowledgeBase(db.Model):
    """Knowledge base for RAG system"""
    id = db.Column(db.Integer, primary_key=True)
    title = db.Column(db.String(255), nullable=False)
    content = db.Column(db.Text, nullable=False)
    category = db.Column(db.String(50), nullable=False)  # nutrition, exercise, health, recipes
    tags = db.Column(db.String(500))  # Comma-separated tags
    source = db.Column(db.String(100))  # Source of information
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

class DocumentEmbedding(db.Model):
    """Store document embeddings for vector search"""
    id = db.Column(db.Integer, primary_key=True)
    document_id = db.Column(db.Integer, db.ForeignKey('knowledge_base.id'), nullable=False)
    embedding = db.Column(db.Text, nullable=False)  # JSON array of embedding vector
    model_name = db.Column(db.String(50), default='text-embedding-ada-002')
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    
    # Relationship
    document = db.relationship('KnowledgeBase', backref='embeddings')

class RAGChatHistory(db.Model):
    """Store RAG chat conversations"""
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    session_id = db.Column(db.String(100), nullable=False, index=True)
    message_type = db.Column(db.String(20), nullable=False)  # user, assistant
    content = db.Column(db.Text, nullable=False)
    retrieved_documents = db.Column(db.Text)  # JSON array of retrieved document IDs
    timestamp = db.Column(db.DateTime, default=datetime.utcnow)
    
    # Relationship
    user = db.relationship('User', backref='rag_chats')

class DailyTargets(db.Model):
    """Store daily nutrition targets for users"""
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    date = db.Column(db.Date, default=datetime.utcnow().date, nullable=False)
    target_calories = db.Column(db.Float, nullable=False)
    target_protein_g = db.Column(db.Float, nullable=False)
    target_fat_g = db.Column(db.Float, nullable=False)
    target_carbs_g = db.Column(db.Float, nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    
    # Relationship
    user = db.relationship('User', backref='daily_targets')
    
    # Unique constraint to prevent duplicate targets for same date
    __table_args__ = (db.UniqueConstraint('user_id', 'date'),)

class DailyProgress(db.Model):
    """Store daily nutrition progress tracking"""
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    date = db.Column(db.Date, default=datetime.utcnow().date, nullable=False)
    consumed_calories = db.Column(db.Float, default=0.0)
    consumed_protein_g = db.Column(db.Float, default=0.0)
    consumed_fat_g = db.Column(db.Float, default=0.0)
    consumed_carbs_g = db.Column(db.Float, default=0.0)
    meals_logged = db.Column(db.Integer, default=0)
    last_updated = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    
    # Relationship
    user = db.relationship('User', backref='daily_progress')
    
    # Unique constraint to prevent duplicate progress for same date
    __table_args__ = (db.UniqueConstraint('user_id', 'date'),)

class CalorieDetectionLog(db.Model):
    """Store calorie detection results from dashboard"""
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    date = db.Column(db.Date, default=datetime.utcnow().date, nullable=False)
    food_items = db.Column(db.Text, nullable=False)  # JSON array of detected foods
    total_calories = db.Column(db.Float, default=0.0)
    total_protein_g = db.Column(db.Float, default=0.0)
    total_fat_g = db.Column(db.Float, default=0.0)
    total_carbs_g = db.Column(db.Float, default=0.0)
    image_filename = db.Column(db.String(255))  # Optional: store the image filename
    confidence_score = db.Column(db.Float, default=0.0)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    logged_to_meals = db.Column(db.Boolean, default=False)  # Track if this detection was logged to meals
    
    # Relationship
    user = db.relationship('User', backref='calorie_detections')
    
    # Unique constraint to prevent duplicate detections for same timestamp
    __table_args__ = (db.UniqueConstraint('user_id', 'created_at'),)


class WorkoutSession(db.Model):
    """A workout session for gym tracking (e.g., Push A on a given date)."""
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    date = db.Column(db.Date, default=datetime.utcnow().date, index=True)
    name = db.Column(db.String(100))  # e.g. Push A, Legs B
    notes = db.Column(db.Text)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    user = db.relationship('User', backref='workout_sessions')


class WorkoutSet(db.Model):
    """Individual exercise entry within a workout session."""
    id = db.Column(db.Integer, primary_key=True)
    session_id = db.Column(db.Integer, db.ForeignKey('workout_session.id'), nullable=False)
    exercise_name = db.Column(db.String(100), nullable=False)
    muscle_group = db.Column(db.String(50))  # chest, back, legs, etc.
    sets = db.Column(db.Integer, default=1)
    reps = db.Column(db.Integer, default=8)
    weight = db.Column(db.Float, default=0.0)  # in kg
    rpe = db.Column(db.Float)  # difficulty 1-10
    notes = db.Column(db.String(255))
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    session = db.relationship('WorkoutSession', backref='sets')

# ===== HARDWARE SENSOR MODELS =====

class Device(db.Model):
    """ESP32 device registration and management"""
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    device_id = db.Column(db.String(64), unique=True, nullable=False)  # ESP32 MAC/UUID
    device_name = db.Column(db.String(100))
    device_type = db.Column(db.String(50))  # food_tracker, fitness_band, health_monitor
    firmware_version = db.Column(db.String(20))
    battery_level = db.Column(db.Integer, default=100)
    last_seen = db.Column(db.DateTime, default=datetime.utcnow)
    is_active = db.Column(db.Boolean, default=True)
    
    user = db.relationship('User', backref='devices')

class HeartRateLog(db.Model):
    """Continuous heart rate monitoring"""
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    device_id = db.Column(db.String(64), db.ForeignKey('device.device_id'))
    bpm = db.Column(db.Integer, nullable=False)
    confidence = db.Column(db.Float)  # Signal quality 0-1
    activity_context = db.Column(db.String(50))  # rest, exercise, post_meal
    timestamp = db.Column(db.DateTime, default=datetime.utcnow, index=True)
    
    user = db.relationship('User', backref='heart_rate_logs')

class SpO2Log(db.Model):
    """Blood oxygen saturation monitoring"""
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    device_id = db.Column(db.String(64), db.ForeignKey('device.device_id'))
    spo2_percentage = db.Column(db.Integer, nullable=False)
    bpm = db.Column(db.Integer)  # Simultaneous heart rate
    confidence = db.Column(db.Float)
    timestamp = db.Column(db.DateTime, default=datetime.utcnow, index=True)
    
    user = db.relationship('User', backref='spo2_logs')

class MotionLog(db.Model):
    """Motion and activity tracking"""
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    device_id = db.Column(db.String(64), db.ForeignKey('device.device_id'))
    activity_type = db.Column(db.String(50))  # walking, running, sitting, sleeping
    steps = db.Column(db.Integer, default=0)
    calories_burned = db.Column(db.Float, default=0.0)
    intensity = db.Column(db.Float)  # 0-1 scale
    duration_seconds = db.Column(db.Integer)
    timestamp = db.Column(db.DateTime, default=datetime.utcnow, index=True)
    
    user = db.relationship('User', backref='motion_logs')

class HealthAlert(db.Model):
    """Health anomaly detection and alerts"""
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    alert_type = db.Column(db.String(50))  # high_heart_rate, low_spo2, abnormal_sleep
    severity = db.Column(db.String(20))  # low, medium, high, critical
    message = db.Column(db.Text, nullable=False)
    sensor_data = db.Column(db.Text)  # JSON of relevant sensor readings
    is_acknowledged = db.Column(db.Boolean, default=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    acknowledged_at = db.Column(db.DateTime)
    
    user = db.relationship('User', backref='health_alerts')
