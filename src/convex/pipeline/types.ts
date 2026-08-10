export type Category =
  | "iraq"
  | "iran"
  | "middle-east"
  | "analysis"
  | "oil"
  | "war"
  | "gold"
  | "usa"
  | "proxies"
  | "economic-impact";

export const CATEGORIES: Category[] = [
  "iraq",
  "war",
  "iran",
  "middle-east",
  "analysis",
  "proxies",
  "gold",
  "usa",
  "oil",
  "economic-impact",
];

export const CATEGORY_PRIORITY: Record<Category, number> = {
  iraq: 70,
  war: 60,
  iran: 50,
  "middle-east": 42,
  analysis: 34,
  proxies: 45,
  gold: 30,
  usa: 30,
  oil: 25,
  "economic-impact": 20,
};

export interface FetchedArticle {
  provider: string;
  sourceName: string | null;
  url: string;
  title: string;
  description: string | null;
  imageUrl: string | null;
  publishedAt: string | null;
}