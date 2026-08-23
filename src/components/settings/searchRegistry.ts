// Settings search index — one entry per searchable card. `id` must match the
// Card's `id` prop so the search modal can switch tab and scroll to it.

export type SettingsTabId =
  | "telegram"
  | "sources"
  | "categories"
  | "style"
  | "editorial"
  | "scheduling"
  | "campaigns"
  | "ai"
  | "system";

export type SettingsSearchEntry = {
  id: string;
  tab: SettingsTabId;
  label: string;
  hint?: string;
  keywords?: string[];
};

export const SETTINGS_INDEX: SettingsSearchEntry[] = [
  { id: "bot-connection", tab: "telegram", label: "Bot Connection", hint: "Bot token status & real-time chat discovery", keywords: ["token", "botfather", "telegram bot", "webhook"] },
  { id: "bots", tab: "telegram", label: "Bots", hint: "Extra bots for category-specific delivery", keywords: ["additional bots", "secondary bot"] },
  { id: "polls", tab: "telegram", label: "Polls", hint: "Send a test poll", keywords: ["vote", "test poll"] },
  { id: "chats", tab: "telegram", label: "Chats", hint: "Destination chats per bot", keywords: ["channels", "groups", "destinations", "chat id"] },

  { id: "providers", tab: "sources", label: "Providers", hint: "RSS, NewsData and publisher feeds", keywords: ["rss", "newsdata", "publisher feeds", "api key"] },
  { id: "telegram-channels", tab: "sources", label: "Telegram Channels", hint: "Monitored channels (the fast lane)", keywords: ["telegram", "fast lane", "signals"] },
  { id: "source-quality", tab: "sources", label: "Source Quality", hint: "Accept/reject rates & auto-pause junk feeds", keywords: ["auto-pause", "quality", "rejections"] },
  { id: "topic-queries", tab: "sources", label: "Topic Queries", hint: "Search topics per category", keywords: ["queries", "search topics"] },

  { id: "category-policy", tab: "categories", label: "Category Policy", hint: "Status, priority, freshness, daily caps and keyword rules per category", keywords: ["categories", "priority", "status", "freshness", "daily cap", "score", "keywords", "review"] },

  { id: "writing-style", tab: "style", label: "AI writing style", hint: "Global tone, style by category and the advanced editor", keywords: ["tone", "register", "style", "auto assist", "voice"] },
  { id: "post-format", tab: "style", label: "Post Format", hint: "Footer, emoji, source names, images and links", keywords: ["footer", "emoji", "link preview", "image", "source names", "read more"] },
  { id: "language", tab: "style", label: "Language", hint: "Default output language", keywords: ["kurdish", "sorani", "english", "ckb"] },
  { id: "hashtag-rules", tab: "style", label: "Hashtag rules", hint: "Category tag + topic tags per category", keywords: ["hashtags", "tags", "topic tags", "hashtag"] },

  { id: "breaking-criteria", tab: "editorial", label: "Breaking-News Criteria", hint: "Which categories trigger breaking alerts", keywords: ["breaking", "alerts"] },
  { id: "news-quality", tab: "editorial", label: "News quality", hint: "Breaking recency, updates and material threshold", keywords: ["recency", "update", "cooldown", "material"] },
  { id: "why-it-matters", tab: "editorial", label: "Why-it-matters follow-ups", hint: "Auto explainer after major breaking stories", keywords: ["explainer", "follow up", "why it matters"] },
  { id: "video-handling", tab: "editorial", label: "Telegram Video Handling", hint: "How channel videos are posted", keywords: ["video", "mp4", "bot api"] },

  { id: "scheduler", tab: "scheduling", label: "Scheduler", hint: "How often each job runs + queue cap", keywords: ["intervals", "cron", "fetch", "queue size", "minutes"] },
  { id: "publishing-speed", tab: "scheduling", label: "Publishing Speed", hint: "Delay between consecutive posts", keywords: ["delay", "pace", "seconds"] },
  { id: "posting-windows", tab: "scheduling", label: "Posting Windows", hint: "Day/night windows and spacing", keywords: ["day", "night", "window", "spacing", "hours"] },
  { id: "campaigns", tab: "campaigns", label: "Campaigns", hint: "Manual multi-part campaigns and delivery", keywords: ["manual", "parts", "delivery", "campaign"] },

  { id: "ai-dedup", tab: "ai", label: "AI Dedup", hint: "Final duplicate check", keywords: ["duplicate", "dedupe", "dedup"] },
  { id: "translation-provider", tab: "ai", label: "Translation Provider", hint: "Model selection", keywords: ["gemini", "model", "provider"] },
  { id: "translation-model-order", tab: "ai", label: "Translation model order", hint: "Fallback order, drag to reorder", keywords: ["fallback", "minimax", "order"] },
  { id: "translation-keys", tab: "ai", label: "Translation API Keys", hint: "Stored provider keys", keywords: ["api key", "gemini key", "key"] },
  { id: "gemini-usage", tab: "ai", label: "Gemini Key Usage", hint: "Per-key usage + live quota check", keywords: ["quota", "429", "usage", "rate limit"] },
  { id: "glossary", tab: "ai", label: "Translation Glossary", hint: "Fixed terms for translation", keywords: ["terms", "dictionary", "glossary"] },
  { id: "translation-history", tab: "ai", label: "Translation History", hint: "Recent translations (diagnostics)", keywords: ["logs", "recent translations", "history"] },
  { id: "translation-failures", tab: "ai", label: "Translation Failures", hint: "Recent errors (diagnostics)", keywords: ["errors", "fails", "failed"] },
  { id: "rewrite-log", tab: "ai", label: "AI Rewrite Log", hint: "Rewrite attempts (diagnostics)", keywords: ["rewrite", "attempts"] },
  { id: "rewrite-analytics", tab: "ai", label: "Rewrite Analytics", hint: "Success rate and trend (diagnostics)", keywords: ["success rate", "trend", "analytics"] },

  { id: "system-status", tab: "system", label: "System Status", hint: "Deployed backend health", keywords: ["health", "schema", "migrations", "queue"] },
  { id: "cron-health", tab: "system", label: "Scheduler (pg_cron)", hint: "Pipeline ticker health", keywords: ["cron", "ticker", "job"] },
  { id: "security", tab: "system", label: "Security", hint: "PIN protection and lockout", keywords: ["pin", "lockout", "password", "lock"] },
];
