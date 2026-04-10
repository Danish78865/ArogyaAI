from openai import OpenAI
from dotenv import load_dotenv
import base64
import json
import sys
import os

load_dotenv()
client = OpenAI()

def get_calories_from_image(image_path):
    print(f"🖼️ Processing image: {image_path}")

    with open(image_path, "rb") as image:
        base64_image = base64.b64encode(image.read()).decode("utf-8")

    try:
        response = client.chat.completions.create(
            model="gpt-4o-mini",
            response_format={"type": "json_object"},
            messages=[
                {
                    "role": "system",
                    "content": """You are a dietitian and vision model. The user sends a meal image. Identify distinct foods, estimate calories and macro nutrition, and provide confidences. Respond ONLY as compact JSON with this exact shape:

{
  "reasoning": "1-2 short sentences",
  "food_items": [
    {"name": "string", "calories": number, "confidence": number},
    {"name": "string", "calories": number, "confidence": number}
  ],
  "nutrition": {
    "calories": number,
    "protein_g": number,
    "carbs_g": number,
    "fat_g": number,
    "fiber_g": number,
    "sugar_g": number,
    "sodium_mg": number
  },
  "total": number
}

Rules:
- confidence is a probability 0..1
- Totals should match food_items approximately.
- Use integers where reasonable.
"""
                },
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "Identify items, calories, nutrition, and confidences for this meal."},
                        {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{base64_image}"}}
                    ]
                },
            ],
        )

        response_message = response.choices[0].message
        content = response_message.content
        print("🧠 Raw response content:", content)  # 👈 Add this line for debugging

        return json.loads(content)

    except Exception as e:
        print(f"⚠️ Error in get_calories_from_image: {e}")
        return {"error": str(e), "total": 0}
