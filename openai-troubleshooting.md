# OpenAI API Troubleshooting Guide

## Issue: OpenAI Returns Welcome Message Instead of Processing Data

### Problem
The OpenAI API is returning:
```
Welcome to the OpenAI API! Documentation is available at https://platform.openai.com/docs/api-reference
```

### Root Causes & Solutions

## 1. API Key Issues

### Check API Key Validity
```bash
# Test API key directly
curl https://api.openai.com/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{"role": "user", "content": "Hello"}],
    "max_tokens": 5
  }'
```

### Solution: Configure Proper API Key in n8n
1. Go to n8n Settings
2. Click "Credentials" 
3. Add "OpenAI API" credential
4. Enter your valid OpenAI API key
5. Test the connection

## 2. Model Selection Issues

### Changed from gpt-4o to gpt-4o-mini
- **gpt-4o**: May have access restrictions
- **gpt-4o-mini**: More reliable and cost-effective

## 3. Request Format Issues

### Correct Request Format
```json
{
  "model": "gpt-4o-mini",
  "messages": [
    {"role": "system", "content": "You are a nutritionist..."},
    {"role": "user", "content": "Analyze this data..."}
  ],
  "temperature": 0.7
}
```

## 4. n8n Configuration Steps

### Step 1: Add OpenAI Credential
1. n8n Dashboard
2. Settings (gear icon)
3. Credentials
4. Add Credential
5. Select "OpenAI"
6. Name: "OpenAI API"
7. API Key: Your actual OpenAI API key
8. Test Connection

### Step 2: Update Workflow
1. Import the fixed workflow: `daily-nutrition-proper-ai.json`
2. In the "AI Nutrition Analysis" node:
   - Select the OpenAI credential
   - Verify model is "gpt-4o-mini"
   - Check message format

### Step 3: Test Workflow
1. Click "Execute Workflow"
2. Check the AI node output
3. Verify proper JSON response

## 5. Alternative: Add Fallback Logic

The workflow already includes fallback content if OpenAI fails:

```javascript
// Fallback content if AI fails
aiAnalysis = {
  assessment: 'Your nutrition tracking is going well!',
  insights: 'Continue monitoring your macros for optimal results.',
  hydration: 'Remember to stay hydrated throughout the day.',
  recommendations: 'Focus on hitting your protein targets tomorrow.',
  motivation: 'You\'re making great progress on your health journey!'
};
```

## 6. Quick Test Workflow

Create a simple test to verify OpenAI works:

```json
{
  "name": "OpenAI Test",
  "nodes": [
    {
      "parameters": {
        "resource": "chat",
        "operation": "create", 
        "model": "gpt-4o-mini",
        "messages": {
          "values": [
            {
              "role": "user",
              "content": "Say 'OpenAI is working!' in JSON format"
            }
          ]
        }
      },
      "name": "Test OpenAI",
      "type": "n8n-nodes-base.openAi",
      "typeVersion": 1.1,
      "position": [240, 300]
    }
  ]
}
```

## 7. Expected Proper Response

### Correct AI Output Should Be:
```json
{
  "assessment": "Great job hitting your nutrition targets today!",
  "insights": "Your protein intake is excellent at 112% of target.",
  "hydration": "Good hydration effort, try adding 2 more glasses tomorrow.",
  "recommendations": "Increase complex carbs by 30g and maintain current protein.",
  "motivation": "You're building excellent nutrition habits!"
}
```

### NOT:
```
Welcome to the OpenAI API! Documentation is available at https://platform.openai.com/docs/api-reference
```

## 8. Final Checklist

- [ ] Valid OpenAI API key configured in n8n
- [ ] Using gpt-4o-mini model (more reliable)
- [ ] Proper message format with system and user roles
- [ ] n8n credential tested successfully
- [ ] Workflow imported and configured
- [ ] Test execution shows proper AI response

## 9. If Still Not Working

### Check OpenAI Account
1. Log into https://platform.openai.com/
2. Verify API key is active
3. Check account balance/credits
4. Review API usage limits

### Alternative Models
Try using different models:
- `gpt-3.5-turbo` (most reliable)
- `gpt-4o-mini` (balanced)
- `gpt-4o` (if access available)
