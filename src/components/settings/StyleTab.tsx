// Style tab — HOW a post is written and presented: AI writing style (global,
// per-category and the advanced editor), post format (footer/emoji/source
// names/link previews/images/links), output language, and the hashtag rules.

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { FileText, Hash, Languages, Palette, Settings2 } from "lucide-react";
import { Card, CompactInput, CompactSelect, CompactToggle, useSettings } from "./shared";

const WRITING_STYLE_OPTIONS = [
  { value: "current", label: "Current version", description: "Keep today's wire-editor behavior unchanged." },
  { value: "professional", label: "Professional", description: "Formal, structured, neutral, and precise." },
  { value: "conversational", label: "Conversational", description: "Friendly and clear without becoming informal." },
  { value: "casual", label: "Casual", description: "Relaxed and approachable; use sparingly for hard news." },
  { value: "explainer", label: "Explainer", description: "Context-first: what changed, why it matters, and what to watch." },
  { value: "simple", label: "Simple", description: "Plain words, short sentences, and low jargon." },
];
const STYLE_VALUES = new Set(WRITING_STYLE_OPTIONS.map((style) => style.value));
const GLOBAL_STYLE_OPTIONS = [
  { value: "auto", label: "Auto assist", description: "Choose a safe register from the story type and category." },
  ...WRITING_STYLE_OPTIONS,
];
const GLOBAL_STYLE_VALUES = new Set(GLOBAL_STYLE_OPTIONS.map((style) => style.value));
const STYLE_CATEGORY_OPTIONS = [{ value: "auto", label: "Auto — follow policy" }, ...WRITING_STYLE_OPTIONS];
const STYLE_EDITOR_DEFAULTS: Record<string, { rule: string; example: string }> = {
  current: {
    rule: "Use the existing neutral wire-editor rules. Do not introduce a new tone or structure.",
    example: "Officials said the talks would continue, but no agreement was announced.",
  },
  professional: {
    rule: "Write like a professional wire service: formal but readable, neutral, precise, and complete. Use full names and titles when known. Lead with the verified development and keep attribution clear.",
    example: "Officials are weighing a two-week extension of the ceasefire, regional sources said.",
  },
  conversational: {
    rule: "Use a warm, reader-friendly voice and short clear sentences. You may use a light 'Here is what happened' framing, but remain factual, restrained, and suitable for a news channel.",
    example: "Here is what happened: officials said they were open to the proposal, but had not signed anything yet.",
  },
  casual: {
    rule: "Use an approachable, relaxed voice with simple sentence rhythm. Never use slang, jokes, hype, or a casual tone for casualties, attacks, or unverified claims.",
    example: "Gold is climbing again as investors react to market concerns.",
  },
  explainer: {
    rule: "Put the development in context: explain what changed, why it matters, who is affected, and what to watch next. Clearly separate source-reported facts from analysis. Do not invent context absent from the source.",
    example: "The extension would buy two more weeks of calm, but the core dispute would remain unresolved.",
  },
  simple: {
    rule: "Use plain everyday words, short sentences, and an easy reading level. Keep exact figures, names, dates, and attribution. Avoid jargon and do not remove important qualifications.",
    example: "Several cargo ships changed route because of the disruption. Two were stopped, according to the report.",
  },
};

function safeStyleRules(value: unknown): Record<string, { rule: string; example: string }> {
  if (!value || typeof value !== "object") return {};
  const result: Record<string, { rule: string; example: string }> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!STYLE_VALUES.has(key) || !raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    result[key] = { rule: String(row.rule ?? ""), example: String(row.example ?? "") };
  }
  return result;
}

type HashtagTopicDraft = { en: string; ckb: string; keywords: string[]; enabled: boolean };
type HashtagRuleDraft = { categoryEn?: string; categoryCkb?: string; topicLimit: number; topics: HashtagTopicDraft[] };

function safeHashtagRules(value: unknown): Record<string, HashtagRuleDraft> {
  if (!value || typeof value !== "object") return {};
  const result: Record<string, HashtagRuleDraft> = {};
  for (const [category, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const topics = Array.isArray(row.topics)
      ? row.topics.filter((topic): topic is Record<string, unknown> => Boolean(topic) && typeof topic === "object").map((topic) => ({
          en: String(topic.en ?? ""),
          ckb: String(topic.ckb ?? ""),
          keywords: Array.isArray(topic.keywords) ? topic.keywords.map(String) : [],
          enabled: topic.enabled !== false,
        }))
      : [];
    result[category] = {
      categoryEn: String(row.categoryEn ?? ""),
      categoryCkb: String(row.categoryCkb ?? ""),
      topicLimit: Number(row.topicLimit) === 2 ? 2 : 1,
      topics,
    };
  }
  return result;
}

export function StyleTab() {
  const { s, save, categories } = useSettings();
  const [styleEditorId, setStyleEditorId] = useState("professional");
  const [hashtagEditorCategory, setHashtagEditorCategory] = useState("war");
  const styleByCategory = s["styleByCategory"] && typeof s["styleByCategory"] === "object"
    ? s["styleByCategory"] as Record<string, unknown>
    : {};
  const styleRules = safeStyleRules(s["textStyleRules"]);
  const selectedStyle = WRITING_STYLE_OPTIONS.find((style) => style.value === styleEditorId) ?? WRITING_STYLE_OPTIONS[1]!;
  const selectedRule = styleRules[styleEditorId] ?? STYLE_EDITOR_DEFAULTS[styleEditorId] ?? { rule: "", example: "" };
  const updateStyleRule = (field: "rule" | "example", value: string) => {
    save({ textStyleRules: { ...styleRules, [styleEditorId]: { ...selectedRule, [field]: value } } });
  };
  const hashtagRules = safeHashtagRules(s["hashtagRules"]);
  const activeHashtagCategory = categories.includes(hashtagEditorCategory) ? hashtagEditorCategory : categories[0] ?? "war";
  const activeHashtagRule = hashtagRules[activeHashtagCategory] ?? { topicLimit: 1, topics: [] };
  const updateHashtagRule = (patch: Partial<HashtagRuleDraft>) => {
    save({ hashtagRules: { ...hashtagRules, [activeHashtagCategory]: { ...activeHashtagRule, ...patch } } });
  };
  const updateHashtagTopic = (index: number, patch: Partial<HashtagTopicDraft>) => {
    updateHashtagRule({ topics: activeHashtagRule.topics.map((topic, i) => i === index ? { ...topic, ...patch } : topic) });
  };

  // Operator-configured footer hyperlinks (post_links jsonb) — seeded once
  // from the server, then treated as local state so typing isn't clobbered
  // by the poll while an edit is in flight.
  const [postLinks, setPostLinks] = useState<Array<{ url: string; text: string }>>([]);
  const [postLinksSeeded, setPostLinksSeeded] = useState(false);
  useEffect(() => {
    if (postLinksSeeded || !s?.postLinks) return;
    setPostLinksSeeded(true);
    const raw = (s as Record<string, any>)?.postLinks;
    const parsed: Array<{ url: string; text: string }> = [];
    if (Array.isArray(raw)) {
      for (const entry of raw) {
        let link = entry as any;
        if (typeof link === "string") { try { link = JSON.parse(link); } catch { continue; } }
        if (!link || typeof link !== "object") continue;
        const url = String(link.url ?? "").trim();
        const text = String(link.text ?? "").trim();
        if (url && text) parsed.push({ url, text });
      }
    }
    setPostLinks(parsed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s?.postLinks, postLinksSeeded]);
  const commitPostLinks = (next: Array<{ url: string; text: string }>) => {
    setPostLinks(next);
    save({ postLinks: next });
  };

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 auto-rows-min gap-4">
      {/* Writing styles */}
      <Card
        icon={Palette}
        id="writing-style"
        title="AI writing style"
        hint="Control the register without changing facts, figures, attribution, or source meaning"
        className="sm:col-span-2"
      >
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <CompactSelect
              label="Global writing style"
              value={String(s["textStyle"] ?? "") === "auto" && s["textStyleAuto"] === false
                ? "professional"
                : GLOBAL_STYLE_VALUES.has(String(s["textStyle"] ?? ""))
                  ? String(s["textStyle"])
                  : "professional"}
              onChange={(v) => save({ textStyle: v, textStyleAuto: v === "auto" })}
              options={GLOBAL_STYLE_OPTIONS}
            />
            <CompactSelect
              label="Summary length"
              value={String(s["textLength"] ?? "auto")}
              onChange={(v) => save({ textLength: v })}
              options={[
                { value: "auto", label: "Auto — based on source richness" },
                { value: "brief", label: "Brief — up to 2 sentences" },
                { value: "standard", label: "Standard — 3–5 sentences" },
                { value: "long_form", label: "Long-form — 150–300+ words when supported" },
              ]}
            />
          </div>
          <p className="text-[10px] text-muted-foreground">
            Choose a named style to apply globally, or choose Auto assist to let the newsroom policy select a conservative style per story. Category mappings remain stronger than Auto categories; stories without a strong signal use the global fallback.
          </p>
          <CompactToggle
            label="Use automatic category and story rules"
            checked={s["textStyle"] === "auto" || s["textStyleAuto"] === true}
            onChange={(v) => save(v ? { textStyleAuto: true, textStyle: "auto" } : { textStyleAuto: false, textStyle: "professional" })}
            hint="When enabled, breaking and market stories use Simple, analysis uses Explainer, and other stories use your safe global fallback unless mapped below."
          />
          <CompactToggle
            label="AI style assist"
            checked={s["textStyleAiAssist"] === true}
            onChange={(v) => save({ textStyleAiAssist: v })}
            hint="Lets the rewrite model make a small register adjustment when the source clearly calls for it; factual and attribution rules always win. Off gives fully deterministic style application."
          />

          <Separator />
          <div>
            <div className="flex items-center gap-2">
              <Settings2 className="h-3.5 w-3.5 text-primary" />
              <Label className="text-[11px] text-muted-foreground font-medium">Style by category</Label>
            </div>
            <p className="mb-2 text-[10px] text-muted-foreground">
              Set a category to a named style, or leave it on Auto to use the policy above. This is the strongest automatic rule after a manual global setting.
            </p>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {categories.map((category) => {
                const value = String(styleByCategory[category] ?? "auto");
                return (
                  <CompactSelect
                    key={category}
                    label={category}
                    value={STYLE_VALUES.has(value) ? value : "auto"}
                    onChange={(next) => save({ styleByCategory: { ...styleByCategory, [category]: next === "auto" ? undefined : next } })}
                    options={STYLE_CATEGORY_OPTIONS}
                  />
                );
              })}
            </div>
          </div>

          <Separator />
          <div>
            <Label className="text-[11px] text-muted-foreground font-medium">Advanced style editor</Label>
            <p className="mb-2 text-[10px] text-muted-foreground">
              Tune the instruction and example shown to the rewrite model. Keep this about voice and structure; never ask a style to invent facts or hide attribution.
            </p>
            <div className="grid gap-3 lg:grid-cols-[180px_1fr]">
              <div className="space-y-1">
                {WRITING_STYLE_OPTIONS.map((style) => (
                  <button
                    key={style.value}
                    type="button"
                    onClick={() => setStyleEditorId(style.value)}
                    className={`block w-full rounded-md px-2.5 py-2 text-left text-[11px] transition-colors ${style.value === styleEditorId ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}
                  >
                    <span className="font-medium">{style.label}</span>
                    <span className="mt-0.5 block text-[10px] opacity-75">{style.description}</span>
                  </button>
                ))}
              </div>
              <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
                <p className="text-[11px] font-semibold text-foreground">{selectedStyle.label}</p>
                <div>
                  <Label className="text-[10px] text-muted-foreground">Prompt rule</Label>
                  <Textarea
                    value={selectedRule.rule}
                    onChange={(e) => updateStyleRule("rule", e.target.value)}
                    placeholder="Describe the voice, sentence rhythm, and structure…"
                    rows={4}
                    dir="auto"
                    className="mt-1 resize-y text-xs"
                  />
                </div>
                <div>
                  <Label className="text-[10px] text-muted-foreground">Example shown to AI</Label>
                  <Textarea
                    value={selectedRule.example}
                    onChange={(e) => updateStyleRule("example", e.target.value)}
                    placeholder="Write a short example of the desired style…"
                    rows={3}
                    dir="auto"
                    className="mt-1 resize-y text-xs"
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      </Card>

      {/* Summary source — Tier 1 extractive lede + Tier 3 AI compression */}
      <Card icon={Settings2} id="summary-source" title="Summary source" hint="How post summaries are produced from the original article">
        <div className="space-y-1">
          <CompactToggle
            label="Keep original headline + lede (short articles)"
            hint="Bodies of 240–800 chars ship the journalist's own headline and opening sentences verbatim — zero AI calls. Filters and gates still apply."
            checked={s["extractiveLede"] !== false}
            onChange={(v) => save({ extractiveLede: v })}
          />
          <CompactToggle
            label="AI compression instead of full rewrite (long articles)"
            hint="Longer bodies get one cheap AI call: compress to your summary length keeping every figure, name and quote — nothing added."
            checked={s["aiCompress"] !== false}
            onChange={(v) => save({ aiCompress: v })}
          />
        </div>
      </Card>

      {/* Post Format */}
      <Card icon={FileText} id="post-format" title="Post Format" hint="Customise how posts appear in Telegram">
        <div className="space-y-3">
          <CompactInput
            label="Footer text"
            value={s["postFooter"] ?? ""}
            onChange={(v) => save({ postFooter: v })}
            placeholder='e.g. "Iran Desk · @yourchannel"'
          />
          <CompactInput
            label="Footer emoji"
            value={s["postEmoji"] ?? ""}
            onChange={(v) => save({ postEmoji: v })}
            placeholder="📌"
          />
          <CompactInput
            label='"Read more" link label'
            value={s["postLinkLabel"] ?? "Read more"}
            onChange={(v) => save({ postLinkLabel: v })}
          />
          <CompactInput
            label="Breaking prefix"
            value={s["breakingPrefix"] ?? "🚨 BREAKING"}
            onChange={(v) => save({ breakingPrefix: v })}
          />
          <Separator className="!my-2" />
          <CompactToggle
            label="Show timestamp"
            checked={s["postShowTimestamp"] !== false}
            onChange={(v) => save({ postShowTimestamp: v })}
          />
          <CompactToggle
            label="Show Telegram source names"
            checked={s["postShowTelegramSource"] !== false}
            onChange={(v) => save({ postShowTelegramSource: v })}
            hint="e.g. @ajanews — the channel name under the post"
          />
          <CompactToggle
            label="Show website source names"
            checked={s["postShowWebSource"] !== false}
            onChange={(v) => save({ postShowWebSource: v })}
            hint="e.g. Mehr News — for RSS / NewsData / website sources"
          />
          <CompactToggle
            label="Source trust-tier tag"
            checked={s["sourceTierEnabled"] !== false}
            onChange={(v) => save({ sourceTierEnabled: v })}
            hint="Adds Wire / State media / Independent / Analysis after the source name"
          />
          <CompactToggle
            label="Telegram link previews"
            checked={s["linkPreviews"] !== false}
            onChange={(v) => save({ linkPreviews: v })}
            hint="Shows URL preview cards under posts"
          />
          <CompactToggle
            label="Grab article image"
            checked={s["grabImages"] !== false}
            onChange={(v) => save({ grabImages: v })}
            hint="On: always grabs the source image and posts it beside the text. Off: text only."
          />
          <CompactToggle
            label="Rich summaries"
            checked={s["enrichSummaries"] !== false}
            onChange={(v) => save({ enrichSummaries: v })}
            hint="Fetches the full article when the feed snippet is short, so posts are complete without opening the source link."
          />
          <Separator className="!my-2" />
          <div>
            <Label className="text-xs">Footer hyperlinks</Label>
            <p className="mb-2 text-[10px] text-muted-foreground">
              Shown as the last line of every post — add, edit or remove.
            </p>
            {postLinks.length === 0 ? (
              <p className="mb-2 text-[10px] text-muted-foreground/70">No links yet.</p>
            ) : (
              <div className="space-y-2">
                {postLinks.map((link, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Input
                      value={link.text}
                      onChange={(e) => commitPostLinks(postLinks.map((l, j) => (j === i ? { ...l, text: e.target.value } : l)))}
                      placeholder="Label"
                      className="h-8 text-xs"
                    />
                    <Input
                      value={link.url}
                      onChange={(e) => commitPostLinks(postLinks.map((l, j) => (j === i ? { ...l, url: e.target.value } : l)))}
                      placeholder="https://…"
                      className="h-8 text-xs"
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 w-8 shrink-0 p-0 text-destructive"
                      onClick={() => commitPostLinks(postLinks.filter((_, j) => j !== i))}
                    >
                      ✕
                    </Button>
                  </div>
                ))}
              </div>
            )}
            <Button
              size="sm"
              variant="outline"
              className="mt-2 h-8 text-[11px]"
              onClick={() => commitPostLinks([...postLinks, { url: "", text: "" }])}
            >
              + Add link
            </Button>
          </div>
        </div>
      </Card>

      {/* Language */}
      <Card icon={Languages} id="language" title="Language" hint="Default output language">
        <CompactSelect
          label="News language"
          value={s["defaultLanguage"] ?? "en"}
          onChange={(v) => save({ defaultLanguage: v })}
          options={[
            { value: "en", label: "English" },
            { value: "ckb", label: "Kurdish Sorani" },
            { value: "both", label: "Both (per chat)" },
          ]}
        />
        <Separator />
        <CompactToggle
          label="Auto hashtags"
          hint="Append the selected category and matching topic hashtags at the very bottom of every post, in the post's language"
          checked={s["autoHashtag"] !== false}
          onChange={(v) => save({ autoHashtag: v })}
        />
      </Card>

      {/* Hashtag rules */}
      <Card
        icon={Hash}
        id="hashtag-rules"
        title="Hashtag rules"
        hint="Category first, then up to one or two matching topics selected here"
        className="sm:col-span-2"
      >
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <CompactSelect
              label="Edit category"
              value={activeHashtagCategory}
              onChange={setHashtagEditorCategory}
              options={categories.map((category) => ({ value: category, label: category }))}
            />
            <CompactSelect
              label="Topic hashtags per post"
              value={String(activeHashtagRule.topicLimit === 2 ? 2 : 1)}
              onChange={(v) => updateHashtagRule({ topicLimit: Number(v) === 2 ? 2 : 1 })}
              options={[
                { value: "1", label: "One topic" },
                { value: "2", label: "Up to two topics" },
              ]}
            />
          </div>
          <p className="text-[10px] text-muted-foreground">
            The category hashtag is always first. Enabled topic rules are selected only when a keyword appears in the article. This keeps hashtags relevant while your Settings choices remain the only source of control—there are no per-post overrides.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <CompactInput
              label="Category tag in English (optional)"
              value={activeHashtagRule.categoryEn ?? ""}
              onChange={(v) => updateHashtagRule({ categoryEn: v })}
              placeholder="Blank uses the built-in category tag"
            />
            <CompactInput
              label="Category tag in Kurdish (optional)"
              value={activeHashtagRule.categoryCkb ?? ""}
              onChange={(v) => updateHashtagRule({ categoryCkb: v })}
              placeholder="Blank uses the built-in Kurdish tag"
            />
          </div>
          <div className="space-y-2">
            <Label className="text-[11px] text-muted-foreground font-medium">Topic tag list</Label>
            {activeHashtagRule.topics.length === 0 ? (
              <p className="rounded-md border border-dashed border-border px-3 py-3 text-[10px] text-muted-foreground">No topic rules for this category yet. Add one to enable category + topic hashtags.</p>
            ) : activeHashtagRule.topics.map((topic, index) => (
              <div key={index} className="rounded-lg border border-border bg-muted/30 p-2.5">
                <div className="grid gap-2 sm:grid-cols-[1fr_1fr_1.4fr_auto_auto] sm:items-end">
                  <CompactInput
                    label="English tag"
                    value={topic.en}
                    onChange={(v) => updateHashtagTopic(index, { en: v })}
                    placeholder="e.g. Missiles"
                  />
                  <CompactInput
                    label="Kurdish tag"
                    value={topic.ckb}
                    onChange={(v) => updateHashtagTopic(index, { ckb: v })}
                    placeholder="e.g. مووشەک"
                  />
                  <CompactInput
                    label="Matching keywords"
                    value={topic.keywords.join(", ")}
                    onChange={(v) => updateHashtagTopic(index, { keywords: v.split(",").map((word) => word.trim()).filter(Boolean) })}
                    placeholder="missile, rocket, ballistic"
                  />
                  <CompactToggle
                    label="Enabled"
                    checked={topic.enabled}
                    onChange={(v) => updateHashtagTopic(index, { enabled: v })}
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-8 w-8 p-0 text-destructive"
                    title="Remove topic rule"
                    onClick={() => updateHashtagRule({ topics: activeHashtagRule.topics.filter((_, i) => i !== index) })}
                  >
                    ✕
                  </Button>
                </div>
              </div>
            ))}
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 text-[11px]"
              onClick={() => updateHashtagRule({ topics: [...activeHashtagRule.topics, { en: "", ckb: "", keywords: [], enabled: true }] })}
            >
              + Add topic tag
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
