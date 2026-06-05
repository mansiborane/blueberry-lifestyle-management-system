<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/5e804931-7fee-484a-ad6e-8685a96d8444

## Run Locally

**Prerequisites:** Node.js

1. Install dependencies:
   `npm install`
2. Create your env file and set keys:
   - Copy `.env.example` to `.env.local`
   - Set `GEMINI_API_KEY` (used by AI features). You can also leave it blank and
     enter a key per-browser under **Settings** in the app.
   - Optional: **Google sign-in** — add `VITE_FIREBASE_*` from [Firebase Console](https://console.firebase.google.com/) → Project settings → Your apps → Web. Enable **Authentication → Sign-in method → Google**. Under **Authorized domains**, add `localhost` (and your production host when you deploy).
3. Start the app (backend + frontend):
   `npm run dev`

AI runs entirely in the Node server via Google **Gemini** (`gemini-2.5-flash`) —
there is no separate Python service to run.

## AI Endpoints (served by the Node server via Gemini)

- `POST /api/ai/suggestions` -> module-specific recommendations
- `POST /api/ai/thought-of-day` -> daily motivational quote
- `POST /api/ai/daily-coach` -> cross-module coaching output
- `POST /api/ai/weekly-recap` -> week summary + next-week focus (dashboard)
- `POST /api/ai/meal-estimate` -> JSON estimates for calories, protein, vitamins from a meal description
- `POST /api/ai/wellness-reflect` -> journal reflection (summary, encouragement, next prompt)
- `POST /api/ai/mood-support` -> personalized guidance for the Mood Check
- `POST /api/ai/health-profile-suggest` -> targets + personalized plan
- `POST /api/ai/validate-llm-config` -> validate a Gemini API key
