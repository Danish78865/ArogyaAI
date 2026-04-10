const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');

let openaiClient = null;

function getOpenAIClient() {
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openaiClient;
}

/**
 * Analyze a food image using GPT-4o Vision
 * Returns structured nutrition data
 */
async function analyzeFoodImage(imagePath) {
  const client = getOpenAIClient();

  let imageContent;

  // Handle both URL and local file paths
  if (imagePath.startsWith('http://') || imagePath.startsWith('https://')) {
    imageContent = { type: 'image_url', image_url: { url: imagePath, detail: 'high' } };
  } else {
    // Read local file and convert to base64
    const imageBuffer = fs.readFileSync(imagePath);
    const base64Image = imageBuffer.toString('base64');
    const ext = path.extname(imagePath).toLowerCase().slice(1);
    const mimeType = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
    imageContent = {
      type: 'image_url',
      image_url: { url: `data:${mimeType};base64,${base64Image}`, detail: 'high' }
    };
  }

  const prompt = `You are an expert nutritionist and dietitian. Analyze this food image and provide detailed nutritional information.

Carefully examine the image and identify ALL food items visible. Estimate portion sizes based on visual cues (plate size, context, etc.).

Respond ONLY with a valid JSON object in this exact format:
{
  "food_items": [
    {
      "name": "Food item name",
      "quantity": "estimated portion (e.g., '1 cup', '150g', '1 medium')",
      "calories": 250,
      "protein_g": 12.5,
      "carbs_g": 30.0,
      "fat_g": 8.0,
      "fiber_g": 2.5,
      "confidence": 0.85
    }
  ],
  "total_calories": 250,
  "total_protein_g": 12.5,
  "total_carbs_g": 30.0,
  "total_fat_g": 8.0,
  "total_fiber_g": 2.5,
  "meal_description": "Brief description of what's in the image",
  "notes": "Any important notes about accuracy or assumptions made"
}

Be as accurate as possible. If you cannot determine exact values, provide reasonable estimates based on standard nutritional databases. All numeric values must be numbers, not strings.`;

  const response = await client.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      {
        role: 'user',
        content: [imageContent, { type: 'text', text: prompt }]
      }
    ],
    max_tokens: 1000,
    temperature: 0.1
  });

  const content = response.choices[0].message.content;

  // Parse JSON from response
  let parsed;
  try {
    // Try to extract JSON from code blocks if present
    const jsonMatch = content.match(/```json\n?([\s\S]*?)\n?```/) ||
                      content.match(/```\n?([\s\S]*?)\n?```/);
    const jsonStr = jsonMatch ? jsonMatch[1] : content;
    parsed = JSON.parse(jsonStr.trim());
  } catch (e) {
    console.error('Failed to parse AI response:', content);
    // Return fallback with raw response
    return {
      food_items: [],
      total_calories: 0,
      total_protein_g: 0,
      total_carbs_g: 0,
      total_fat_g: 0,
      total_fiber_g: 0,
      meal_description: 'Could not analyze image',
      notes: 'AI response parsing failed',
      raw_response: content,
      error: 'Parse error'
    };
  }

  return {
    food_items: parsed.food_items || [],
    total_calories: parseFloat(parsed.total_calories) || 0,
    total_protein_g: parseFloat(parsed.total_protein_g) || 0,
    total_carbs_g: parseFloat(parsed.total_carbs_g) || 0,
    total_fat_g: parseFloat(parsed.total_fat_g) || 0,
    total_fiber_g: parseFloat(parsed.total_fiber_g) || 0,
    meal_description: parsed.meal_description || '',
    notes: parsed.notes || '',
    raw_response: content
  };
}

module.exports = { analyzeFoodImage };
