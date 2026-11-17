# Baseline briefs

Four fixed briefs. Run each once with real Claude through the console (`/api/sessions/:id/route`, `direct`, both approvals, `editor`, `render`), then save the outputs. If a run escalates, record the reason and retry once. Do not change code to get past an escalation.

## Common settings

Duration 15 s, 30 fps, mp4, h264 video, aac audio. Size 1280x720 for 16:9 as instructed. Briefs 3 and 4 are not 16:9, and a size must match its aspect ratio, so they use 720x1280 (9:16) and 720x720 (1:1). Output settings are passed to `POST /api/sessions/:id/render` with source `user_approved` (the person gave these settings in chat).

Briefs 2 to 4 end with the same sound sentence as brief 1: a short spoken English voice-over, no music, at most 2 words per second of the scene. That sentence is a workaround, not a feature: the default voice-over commit `f63cc39` is not on this branch, and the storyboard has no speech-speed check (see `docs/system-audit.md`).

Console: `npm run console` with `SKILLS_INCLUDE_DRAFT=1` and a real `ANTHROPIC_API_KEY` (model `claude-sonnet-5-5`). Template inspiration is on (476 templates in Postgres).

## 1. Logo and brand colours, 16:9, 1280x720

Category `general-promo`. Upload: the DigiKon logo PNG (`storage/sessions/58037c158ca7/uploads/asset_d51594c3.png`, 558x158). Brief as routed:

> Promote DigiKon Solutions by showcasing its complete range of digital services, with a strong focus on GoHighLevel automation, CRM systems, website and mobile app development, and our in-house AI tools, including Product SEO Automation and AI Video Generation. Build brand awareness, demonstrate our capabilities, attract potential clients, and generate business leads. Audience: Small and medium-sized business owners, entrepreneurs, startup founders, marketing agencies, e-commerce businesses, digital marketers, and companies looking to automate operations, improve their online presence, generate more leads, and adopt AI-powered solutions. Platform: LinkedIn. Brand: colours #03171d, #1c2e33, #f7f8f5, #ffffff, #81d870, #b2ee9e, #647174; fonts Manrope, DM Serif Display; tone Professional, modern, innovative, confident, trustworthy, premium, and business-focused. Use clear, persuasive, customer-centric language. Highlight expertise, automation, efficiency, and business growth. Avoid exaggerated claims and unnecessary technical jargon. 16:9 Make it a 15 second video, 16:9, for LinkedIn. The attached image is our logo. Add a short spoken voice-over narration in English, no music. Keep each voice-over line short: at most 2 words per second of the scene, so 8 words or fewer for a 4 second scene.

## 2. No assets, 16:9, 1280x720

Category `ecommerce`. No uploads.

> Promote Ember Roast, a weekly coffee subscription that delivers freshly roasted beans from small farms. Audience: home coffee lovers aged 25 to 45. Platform: Instagram. Tone: warm, crafted, calm. Avoid exaggerated claims. Make it a 15 second video, 16:9. Add a short spoken voice-over narration in English, no music. Keep each voice-over line short: at most 2 words per second of the scene, so 8 words or fewer for a 4 second scene.

## 3. Vertical, 9:16, 720x1280

Category `ecommerce`. No uploads.

> Promote Crumb, a mobile app for ordering from local bakeries for same-day pickup. Audience: busy city professionals and students. Platform: Instagram Reels, vertical. Tone: playful, friendly, quick. Avoid exaggerated claims. Make it a 15 second video, 9:16. Add a short spoken voice-over narration in English, no music. Keep each voice-over line short: at most 2 words per second of the scene, so 8 words or fewer for a 4 second scene.

## 4. Square, 1:1, 720x720

Category `saas`. No uploads.

> Promote Ledgerly, invoicing software that helps small teams get paid faster. Audience: freelancers and small agency owners. Platform: LinkedIn feed, square. Tone: clear, confident, no jargon. Avoid exaggerated claims. Make it a 15 second video, 1:1. Add a short spoken voice-over narration in English, no music. Keep each voice-over line short: at most 2 words per second of the scene, so 8 words or fewer for a 4 second scene.
