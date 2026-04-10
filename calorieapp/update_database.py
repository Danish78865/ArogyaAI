#!/usr/bin/env python3
"""
Database update script to add CalorieDetectionLog model
"""

import os
import sys
from flask import Flask
from flask_sqlalchemy import SQLAlchemy
from datetime import datetime
from sqlalchemy import text

# Add the current directory to the path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from models import db, CalorieDetectionLog, WorkoutSession, WorkoutSet, MealLog

def update_database():
    """Update the database with the new CalorieDetectionLog model"""
    app = Flask(__name__)
    app.config["SQLALCHEMY_DATABASE_URI"] = "sqlite:///calorieapp.db"
    app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
    
    db.init_app(app)
    
    with app.app_context():
        try:
            # Create the new CalorieDetectionLog table (if it doesn't exist)
            print("Creating CalorieDetectionLog table...")
            CalorieDetectionLog.__table__.create(db.engine, checkfirst=True)
            print("✅ CalorieDetectionLog table created successfully!")

            inspector = db.inspect(db.engine)

            # Verify the CalorieDetectionLog table exists
            tables = inspector.get_table_names()
            if 'calorie_detection_log' in tables:
                print("✅ calorie_detection_log table verified in database!")
            else:
                print("❌ calorie_detection_log table not found in database!")

            # --- Add missing columns to meal_log if needed ---
            if 'meal_log' in tables:
                columns = [col['name'] for col in inspector.get_columns('meal_log')]

                if 'meal_type' not in columns:
                    print("🔄 Adding missing 'meal_type' column to meal_log table...")
                    db.session.execute(text("ALTER TABLE meal_log ADD COLUMN meal_type VARCHAR(50)"))
                    db.session.commit()
                    print("✅ 'meal_type' column added to meal_log table!")
                else:
                    print("✅ 'meal_type' column already exists on meal_log table.")

                for col_name in ('protein_g', 'fat_g', 'carbs_g'):
                    if col_name not in columns:
                        print(f"🔄 Adding missing '{col_name}' column to meal_log table...")
                        db.session.execute(text(f"ALTER TABLE meal_log ADD COLUMN {col_name} FLOAT DEFAULT 0"))
                        db.session.commit()
                        print(f"✅ '{col_name}' column added to meal_log table!")
                    else:
                        print(f"✅ '{col_name}' column already exists on meal_log table.")
            else:
                print("⚠️ 'meal_log' table not found; skipping meal_type/macro column updates.")

            # --- Ensure workout_session and workout_set tables exist ---
            if 'workout_session' not in tables:
                print("🔄 Creating workout_session table...")
                WorkoutSession.__table__.create(db.engine)
                print("✅ workout_session table created.")
            else:
                print("✅ workout_session table already exists.")

            if 'workout_set' not in tables:
                print("🔄 Creating workout_set table...")
                WorkoutSet.__table__.create(db.engine)
                print("✅ workout_set table created.")
            else:
                print("✅ workout_set table already exists.")

        except Exception as e:
            print(f"❌ Error updating database: {e}")
            return False
    
    return True

if __name__ == "__main__":
    print("🔄 Updating database with CalorieDetectionLog model...")
    success = update_database()
    
    if success:
        print("✅ Database update completed successfully!")
        print("🎯 You can now use the enhanced food logging system!")
    else:
        print("❌ Database update failed!")
        sys.exit(1)
