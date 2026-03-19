import fs from "fs";
import { config } from "../config";
import { AnalysisResult, EntryFile, FileInfo } from "../types";
import path from "path";

/** Approximate tokens per character for code (OpenAI-style estimate) */
const CHARS_PER_TOKEN = 4;

const SCORE__TO_SEND_TO_AI = 10;

/** Hooks with weight <= this are considered "light" for UI-only detection */
const LIGHT_HOOK_MAX_WEIGHT = 2;

function getHookScore(importsByModule: Record<string, string[]>): number {
  const reactImports = importsByModule["react"];
  if (!reactImports?.length) return 0;
  return reactImports.reduce((sum, name) => sum + (HOOK_WEIGHTS[name] ?? 0), 0);
}

/** This function check if the items is using any strong logic module which means it will be sent to AI without checking the score */
function usesStrongLogicModule(
  importsByModule: Record<string, string[]>,
): boolean {
  return Object.keys(importsByModule).some((moduleKey) =>
    STRONG_LOGIC_MODULES.some(
      (strong) => moduleKey === strong || moduleKey.startsWith(strong + "/"),
    ),
  );
}

function isOnlyUiAndShadcn(item: FileInfo): boolean {
  const { importsByModule } = item;
  if (usesStrongLogicModule(importsByModule)) return false;
  const reactImports = importsByModule["react"] ?? [];
  const hasHeavyHooks = reactImports.some(
    (name) => (HOOK_WEIGHTS[name] ?? 0) > LIGHT_HOOK_MAX_WEIGHT,
  );
  if (hasHeavyHooks) return false;
  const allowedModules = ["react", "lucide-react"];
  const isAllowed = (key: string) =>
    allowedModules.includes(key) ||
    key.includes("/ui/") ||
    key.includes("components/ui");
  return Object.keys(importsByModule).every(isAllowed);
}

/** True if this item is a shadcn-style UI primitive (under components/ui) — never send to AI */
function isShadcnUiPrimitive(item: FileInfo): boolean {
  const normalized = (item.outputFile ?? item.sourceFile ?? "")
    .replace(/\\/g, "/")
    .toLowerCase();
  return (
    normalized.startsWith("components/ui/") ||
    normalized.includes("/components/ui/")
  );
}

/** True if file content uses Vite env (import.meta.env.VITE_*) — needs AI to convert to Next.js */
function fileUsesViteEnv(sourceFile: string): boolean {
  if (!sourceFile || !fs.existsSync(sourceFile)) return false;
  try {
    const content = fs.readFileSync(sourceFile, "utf-8");
    return /import\.meta\.env\.VITE_/.test(content);
  } catch {
    return false;
  }
}

const IMAGE_EXTENSIONS = /\.(png|jpg|jpeg|gif|svg|webp|ico|bmp)(\?.*)?$/i;

/** True if the file imports any image (e.g. import x from "@/assets/hero-image.png") — needs AI to convert to next/image */
function hasImageImport(importsByModule: Record<string, string[]>): boolean {
  return Object.keys(importsByModule).some((moduleSpecifier) =>
    IMAGE_EXTENSIONS.test(moduleSpecifier),
  );
}

/** Calculate the score for a given item based on the logic */
function calculateScore(item: FileInfo): number {
  const { importsByModule, outputFile } = item;
  // shadcn UI primitives (e.g. form.tsx) are never sent to AI, even if they use react-hook-form
  if (isShadcnUiPrimitive(item)) return 0;
  // if component only uses ui components / shadcn ui component - skip (score 0)
  if (isOnlyUiAndShadcn(item)) return 0;
  // if file uses Vite env vars, send to AI to rewrite to Next.js (process.env / NEXT_PUBLIC_*)
  if (fileUsesViteEnv(item.sourceFile)) return SCORE__TO_SEND_TO_AI;
  // if file imports an image (e.g. import heroImage from "@/assets/hero-image.png"), send to AI to convert to next/image
  if (hasImageImport(importsByModule)) return SCORE__TO_SEND_TO_AI;
  let score = 0;
  // if its page.tsx component score += 2
  if (outputFile.endsWith("page.tsx") || outputFile.includes("/page.tsx")) {
    score += 2;
  }
  // add scores based on HOOK_WEIGHTS for hooks from importsByModule
  score += getHookScore(importsByModule);
  // if using any strong logic module, score is SCORE__TO_SEND_TO_AI
  if (usesStrongLogicModule(importsByModule)) {
    return SCORE__TO_SEND_TO_AI;
  }
  if (item.isAuthProtected) return SCORE__TO_SEND_TO_AI;
  return score;
}

/** Loop all FileInfo items and check if it should be updated by AI based on calculation logic. Calculate the score for each item and set the shouldSendToAi property */
export function updateShouldSendToAI(analysis: AnalysisResult) {
  const items = [
    ...analysis.routes,
    ...analysis.componentFiles,
    ...analysis.extraLogicFilesRoot,
    ...analysis.extraLogicFilesSrc,
  ];
  for (const item of items) {
    if (!item.isScoreCalculated) {
      const score = calculateScore(item);
      item.isScoreCalculated = true;
      item.shouldSendToAi = score >= SCORE__TO_SEND_TO_AI;
    }
  }
}

/** Get all items to send to AI based on the shouldSendToAi property */
export function getItemsToSendToAi(analysis: AnalysisResult) {
  const components = analysis.componentFiles.filter(
    (component) => component.shouldSendToAi,
  );
  const routes = analysis.routes.filter((route) => route.shouldSendToAi);
  const extraLogicFilesRoot = analysis.extraLogicFilesRoot.filter(
    (file) => file.shouldSendToAi,
  );
  const extraLogicFilesSrc = analysis.extraLogicFilesSrc.filter(
    (file) => file.shouldSendToAi,
  );

  return {
    components,
    routes,
    extraLogicFilesRoot,
    extraLogicFilesSrc,
    authProtectedComponent: analysis.authProtectedComponent,
  };
}

/**
 * Builds conversion tasks for component files. Returns an array of objects with sourceFile, targetPath, and isAuthProtected properties.
 * @param nextRoot - Absolute path to the Next.js project (e.g. next-output/{jobId}). Each item's outputFile is resolved under this path.
 * @param items - Items to convert.
 * @returns Conversion tasks.
 */
export function buildComponentConversionTasks(
  nextRoot: string,
  items: {
    components: FileInfo[];
    routes: FileInfo[];
    extraLogicFilesRoot: FileInfo[];
    extraLogicFilesSrc: FileInfo[];
  },
) {
  const task = (file: FileInfo, outputPath: string) => ({
    sourceFile: file.sourceFile,
    targetPath: path.join(nextRoot, outputPath),
    isAuthProtected: file.isAuthProtected ?? false,
  });

  return [
    ...items.components.map((c) => task(c, c.outputFile)),
    ...items.routes.map((r) => task(r, r.outputFile)),
    ...items.extraLogicFilesRoot.map((f) => task(f, f.outputFile)),
    ...items.extraLogicFilesSrc.map((f) =>
      task(f, (f.outputFile ?? "").replace(/^src[/\\]/, "")),
    ),
  ];
}

// AI Logic

/**
 * Logs the items to send to AI.
 */
export function logSendingToAi(
  entryFiles: EntryFile[],
  components: FileInfo[],
  routes: FileInfo[],
  extraLogicFilesRoot: FileInfo[],
  extraLogicFilesSrc: FileInfo[],
) {
  if (config.DEBUG.LOGS) {
    console.log("Entry files to send to ai:", entryFiles);
    console.log("--------------------------------");
    console.log("Components to send to ai:", components);
    console.log("--------------------------------");
    console.log("Routes to send to ai:", routes);
    console.log("--------------------------------");
    console.log(
      "Extra logic files from root directory to send to ai:",
      extraLogicFilesRoot,
    );
    console.log("--------------------------------");
    console.log(
      "Extra logic files from src directory to send to ai:",
      extraLogicFilesSrc,
    );
    console.log("--------------------------------");

    logTokensToSendToAi(
      calculateTokensToSendToAi(
        entryFiles,
        components,
        routes,
        extraLogicFilesRoot,
        extraLogicFilesSrc,
      ),
    );
  }
}

export interface TokenEstimate {
  totalLines: number;
  totalTokens: number;
  fileCount: number;
  byCategory: {
    entryFiles: { lines: number; tokens: number; fileCount: number };
    components: { lines: number; tokens: number; fileCount: number };
    routes: { lines: number; tokens: number; fileCount: number };
    extraLogic: { lines: number; tokens: number; fileCount: number };
    extraLogicSrc: { lines: number; tokens: number; fileCount: number };
  };
}

function getLinesAndTokensForFile(sourceFile: string): {
  lines: number;
  tokens: number;
} {
  try {
    const content = fs.readFileSync(sourceFile, "utf-8");
    const lines = content.split(/\r?\n/).length;
    const tokens = Math.ceil(content.length / CHARS_PER_TOKEN);
    return { lines, tokens };
  } catch {
    return { lines: 0, tokens: 0 };
  }
}

function sumLinesAndTokens(files: FileInfo[] | EntryFile[]): {
  lines: number;
  tokens: number;
  fileCount: number;
} {
  let lines = 0;
  let tokens = 0;
  for (const file of files) {
    const filePath = (file as FileInfo).sourceFile || (file as EntryFile).path;
    const { lines: l, tokens: t } = getLinesAndTokensForFile(filePath);
    lines += l;
    tokens += t;
  }
  return { lines, tokens, fileCount: files.length };
}

/**
 * For every file passed (components, routes, extraLogicFiles), reads the source file,
 * counts lines of code, and estimates approximate token cost for AI (input).
 * Uses ~4 characters per token as a typical code estimate.
 */
function calculateTokensToSendToAi(
  entryFiles: EntryFile[],
  components: FileInfo[],
  routes: FileInfo[],
  extraLogicFilesRoot: FileInfo[],
  extraLogicFilesSrc: FileInfo[],
): TokenEstimate {
  const entryFilesSum = sumLinesAndTokens(entryFiles);
  const componentsSum = sumLinesAndTokens(components);
  const routesSum = sumLinesAndTokens(routes);
  const extraLogicSum = sumLinesAndTokens(extraLogicFilesRoot);
  const extraLogicSumSrc = sumLinesAndTokens(extraLogicFilesSrc);

  return {
    totalLines:
      entryFilesSum.lines +
      componentsSum.lines +
      routesSum.lines +
      extraLogicSum.lines,
    totalTokens:
      entryFilesSum.tokens +
      componentsSum.tokens +
      routesSum.tokens +
      extraLogicSum.tokens,
    fileCount:
      entryFilesSum.fileCount +
      componentsSum.fileCount +
      routesSum.fileCount +
      extraLogicSum.fileCount,
    byCategory: {
      entryFiles: entryFilesSum,
      components: componentsSum,
      routes: routesSum,
      extraLogic: extraLogicSum,
      extraLogicSrc: extraLogicSumSrc,
    },
  };
}

function logTokensToSendToAi(tokens: TokenEstimate) {
  if (config.DEBUG.LOGS) {
    console.log("Total tokens to send to ai:", tokens.totalTokens);
    console.log("Total lines to send to ai:", tokens.totalLines);
    console.log("Total files to send to ai:", tokens.fileCount);
  }
}

const HOOK_WEIGHTS: Record<string, number> = {
  useEffect: 8,
  useSyncExternalStore: 8,

  useTransition: 6,
  useDeferredValue: 6,
  useContext: 6,

  useReducer: 5,

  useState: 2,

  useRef: 1,
  useMemo: 1,
  useCallback: 1,

  useImperativeHandle: 1,
  useDebugValue: 0.5,
  useId: 0.5,
};

const STRONG_LOGIC_MODULES = [
  "react-router-dom",

  // Database
  "@supabase",
  "supabase",
  "firebase",
  "firestore",

  // State
  "zustand",
  "redux",
  "@reduxjs/toolkit",
  "jotai",
  "valtio",
  "mobx",
  "recoil",
  "xstate",

  // Data fetching
  "@tanstack/react-query",
  "swr",
  "apollo-client",
  "urql",
  "relay-runtime",

  // Auth
  "@auth0/auth0-react",
  "firebase",
  "supabase",
  "clerk",
  "lucia",
  "passport",

  // Payments
  "stripe",
  "@stripe/stripe-js",
  "paypal",
  "braintree",
  "paddle",

  // HTTP
  "axios",
  "ky",
  "graphql-request",

  // Forms
  "react-hook-form",
  "formik",
  "final-form",
];

// https://ui.shadcn.com/docs/components
const SHADCN_UI_COMPONENTS_LIST = [
  "Accordion",
  "Alert",
  "Alert Dialog",
  "Aspect Ratio",
  "Avatar",
  "Badge",
  "Breadcrumb",
  "Button",
  "Button Group",
  "Calendar",
  "Card",
  "Carousel",
  "Chart",
  "Checkbox",
  "Collapsible",
  "Combobox",
  "Command",
  "Context Menu",
  "Data Table",
  "Date Picker",
  "Dialog",
  "Direction",
  "Drawer",
  "Dropdown Menu",
  "Empty",
  "Field",
  "Hover Card",
  "Input",
  "Input Group",
  "Input OTP",
  "Item",
  "Kbd",
  "Label",
  "Menubar",
  "Native Select",
  "Navigation Menu",
  "Pagination",
  "Popover",
  "Progress",
  "Radio Group",
  "Resizable",
  "Scroll Area",
  "Select",
  "Separator",
  "Sheet",
  "Sidebar",
  "Skeleton",
  "Slider",
  "Sonner",
  "Spinner",
  "Switch",
  "Table",
  "Tabs",
  "Textarea",
  "Toast",
  "Toggle",
  "Toggle Group",
  "Tooltip",
  "Typography",
];
