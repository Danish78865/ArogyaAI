"""
Script to populate the database with sample food items
"""
import os
import sys
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from models import db, FoodItem, Nutrients
from server import app

def create_sample_foods():
    """Create sample food items with nutrition data"""
    
    sample_foods = [
        # Fruits
        {"name": "Apple", "brand": "Generic", "serving_qty": 1, "serving_unit": "medium (182g)", 
         "calories": 95, "protein_g": 0.5, "fat_g": 0.3, "carbs_g": 25, "fiber_g": 4.4},
        {"name": "Banana", "brand": "Generic", "serving_qty": 1, "serving_unit": "medium (118g)", 
         "calories": 105, "protein_g": 1.3, "fat_g": 0.4, "carbs_g": 27, "fiber_g": 3.1},
        {"name": "Orange", "brand": "Generic", "serving_qty": 1, "serving_unit": "medium (154g)", 
         "calories": 62, "protein_g": 1.2, "fat_g": 0.2, "carbs_g": 15, "fiber_g": 3.1},
        
        # Vegetables
        {"name": "Broccoli", "brand": "Generic", "serving_qty": 1, "serving_unit": "cup (91g)", 
         "calories": 31, "protein_g": 2.6, "fat_g": 0.3, "carbs_g": 6, "fiber_g": 2.4},
        {"name": "Chicken Breast", "brand": "Generic", "serving_qty": 100, "serving_unit": "grams", 
         "calories": 165, "protein_g": 31, "fat_g": 3.6, "carbs_g": 0, "fiber_g": 0},
        {"name": "Brown Rice", "brand": "Generic", "serving_qty": 1, "serving_unit": "cup (195g)", 
         "calories": 216, "protein_g": 5, "fat_g": 1.8, "carbs_g": 45, "fiber_g": 3.5},
        
        # Proteins
        {"name": "Eggs", "brand": "Generic", "serving_qty": 2, "serving_unit": "large (100g)", 
         "calories": 143, "protein_g": 12.6, "fat_g": 9.5, "carbs_g": 0.7, "fiber_g": 0},
        {"name": "Greek Yogurt", "brand": "Generic", "serving_qty": 1, "serving_unit": "cup (245g)", 
         "calories": 146, "protein_g": 20, "fat_g": 3.8, "carbs_g": 9.2, "fiber_g": 0},
        {"name": "Salmon", "brand": "Generic", "serving_qty": 100, "serving_unit": "grams", 
         "calories": 208, "protein_g": 25.4, "fat_g": 12.4, "carbs_g": 0, "fiber_g": 0},
        
        # Grains
        {"name": "Oatmeal", "brand": "Generic", "serving_qty": 1, "serving_unit": "cup (234g)", 
         "calories": 158, "protein_g": 6, "fat_g": 3.2, "carbs_g": 28, "fiber_g": 4},
        {"name": "Whole Wheat Bread", "brand": "Generic", "serving_qty": 2, "serving_unit": "slices (56g)", 
         "calories": 138, "protein_g": 7.6, "fat_g": 2, "carbs_g": 24, "fiber_g": 3.2},
        {"name": "Quinoa", "brand": "Generic", "serving_qty": 1, "serving_unit": "cup (185g)", 
         "calories": 222, "protein_g": 8, "fat_g": 3.6, "carbs_g": 39, "fiber_g": 5},
        
        # Snacks
        {"name": "Almonds", "brand": "Generic", "serving_qty": 28, "serving_unit": "grams (1/4 cup)", 
         "calories": 164, "protein_g": 6, "fat_g": 14, "carbs_g": 6, "fiber_g": 3.5},
        {"name": "Peanut Butter", "brand": "Generic", "serving_qty": 2, "serving_unit": "tablespoons (32g)", 
         "calories": 188, "protein_g": 8, "fat_g": 16, "carbs_g": 6, "fiber_g": 1.6},
        {"name": "Protein Bar", "brand": "Generic", "serving_qty": 1, "serving_unit": "bar (68g)", 
         "calories": 200, "protein_g": 20, "fat_g": 7, "carbs_g": 18, "fiber_g": 3},
        
        # Beverages
        {"name": "Milk", "brand": "Generic", "serving_qty": 1, "serving_unit": "cup (244ml)", 
         "calories": 122, "protein_g": 8.3, "fat_g": 4.8, "carbs_g": 12, "fiber_g": 0},
        {"name": "Protein Shake", "brand": "Generic", "serving_qty": 1, "serving_unit": "scoop (35g)", 
         "calories": 120, "protein_g": 24, "fat_g": 1, "carbs_g": 3, "fiber_g": 1},
        
        # Fast Food
        {"name": "Pizza Slice", "brand": "Generic", "serving_qty": 1, "serving_unit": "slice (107g)", 
         "calories": 285, "protein_g": 12, "fat_g": 10, "carbs_g": 36, "fiber_g": 2.3},
        {"name": "Hamburger", "brand": "Generic", "serving_qty": 1, "serving_unit": "patty (113g)", 
         "calories": 294, "protein_g": 24, "fat_g": 21, "carbs_g": 0, "fiber_g": 0},
        {"name": "French Fries", "brand": "Generic", "serving_qty": 1, "serving_unit": "medium (117g)", 
         "calories": 365, "protein_g": 4, "fat_g": 17, "carbs_g": 48, "fiber_g": 4.2},
    ]
    
    with app.app_context():
        for food_data in sample_foods:
            # Check if food already exists
            existing_food = FoodItem.query.filter_by(name=food_data['name']).first()
            if existing_food:
                print(f"Food '{food_data['name']}' already exists, skipping...")
                continue
            
            # Create food item
            food = FoodItem(
                source='custom',
                name=food_data['name'],
                brand=food_data['brand'],
                serving_qty=food_data['serving_qty'],
                serving_unit=food_data['serving_unit']
            )
            
            db.session.add(food)
            db.session.flush()  # Get the ID without committing
            
            # Create nutrients
            nutrients = Nutrients(
                food_id=food.id,
                calories=food_data['calories'],
                protein_g=food_data['protein_g'],
                fat_g=food_data['fat_g'],
                carbs_g=food_data['carbs_g'],
                fiber_g=food_data.get('fiber_g', 0),
                sugar_g=food_data.get('sugar_g', 0),
                sodium_mg=food_data.get('sodium_mg', 0),
                vitamin_c_mg=food_data.get('vitamin_c_mg', 0),
                iron_mg=food_data.get('iron_mg', 0)
            )
            
            db.session.add(nutrients)
            print(f"Added food: {food_data['name']}")
        
        db.session.commit()
        print(f"Successfully added {len(sample_foods)} food items to the database!")

if __name__ == "__main__":
    create_sample_foods()
