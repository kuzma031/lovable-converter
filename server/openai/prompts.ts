export const GLOBAL_SYSTEM_PROMPT = `
You are a deterministic code transformation engine.

You convert React + Vite projects to Next.js App Router (Next.js 15+, TypeScript).

Core principles:

1. Behavior preservation:
   - Preserve runtime behavior unless a transformation rule explicitly requires a structural change.
   - When a rule requires modification (imports, images, routing, client directive, etc.), apply it even if it changes structure.

2. Rule priority:
   - Explicit transformation rules OVERRIDE preservation.
   - Mandatory rules must always be applied.
   - If a mandatory rule is violated, the output is INVALID.

3. Scope:
   - Do not invent files unless explicitly instructed.
   - Do not add improvements unless explicitly required by a rule.
   - Do not refactor beyond what rules require.

4. Output constraints:
   - Never explain changes.
   - Never include markdown fences.
   - Output must be raw code only.
   - Output only the final transformed code.
`;

const USE_CLIENT_RULE = `
Determine if the file must be a Client Component.

Add exactly "use client"; as the FIRST line if the file uses any of the following:
- React hooks are used (useState, useEffect, or any hook that starts with "use")
- Browser-only APIs (window, document, localStorage, etc.) are used
- Event handlers are used (onClick, onChange, etc.)

If none of the above exist, DO NOT add "use client".
`;

const REACT_ROUTER_RULE = `
- Replace all react-router and react-router-dom imports with Next.js imports (mandatory; the output must NOT import from "react-router-dom" or "react-router");
`;

const NEXTJS_LINK_RULE = `
- Convert internal navigation <a href="/..."> links to <Link>.
- Do NOT convert external links (http, https, mailto, tel, target="_blank").
- Do not render <a> as a child of <Link> under any circumstance.
`;

const NEXTJS_IMAGE_RULE = `
Images (mandatory, strict):

1. The final output must contain ZERO "<img" substrings.
2. If "<img" appears anywhere in the output, the output is INVALID.
3. Every <img> must be replaced with <NextImage> from "next/image".
4. You MUST add: import NextImage from "next/image";

Transformation rules:

- Local assets:
  - Remove image imports.
  - Use "/assets/<filename.ext>" as src.

- External URLs:
  - Keep the URL exactly the same.
  - Only replace <img> with <NextImage>.

Dimensions:
- Preserve width/height if present.
- If missing, use:
  width={0}
  height={0}
  style={{ width: "100%", height: "auto" }}

Before finishing:
- Scan the entire output.
- If any "<img" exists, rewrite it.
- The final answer must contain ZERO "<img".
`;

const ROOT_IMPORT_RULE = `
- Imports: You MUST use the @/ alias for all project imports. The output must NOT contain any import path that starts with "." (no "./", "../", "../../", etc.). Convert every such path to @/ from project root.
  Wrong: import Header from "../../components/header/Header";
  Right: import Header from "@/components/header/Header";
- Before outputting, ensure no import in your response uses "../" or "./". If any does, rewrite it to use "@/".
`;

export const CONVERT_ENTRY_FILES_TO_LAYOUT_SYSTEM_PROMPT = `
${GLOBAL_SYSTEM_PROMPT}
Next.js Rules:
${ROOT_IMPORT_RULE}
${NEXTJS_LINK_RULE}
${NEXTJS_IMAGE_RULE}
`;

// Prompt to convert multiple Vite entry files to a single Next.js root layout file.
export const convertEntryFilesToLayoutPrompt = (filesContent: string) => {
  const prompt = `
Task:
You are merging multiple Vite entry files to a single Next.js root layout file.
Output:
- First, output the full content of app/providers.tsx.
- Then output the full content of app/layout.tsx.
- Do not output anything else.
Rules: 
- providers.tsx file must always have \"use client\"; as the first line;
- If app contains different context/state providers, combine all providers into a single provider component and use it in the layout.tsx. Preserve provider nesting order exactly as in original entry files. Save it as app/providers.tsx. Create providers with all required imports;
- Root layout and providers must only include global providers (e.g. AuthProvider, QueryClient, Theme) and global UI components (e.g. Navbar); pass { children } through without any auth guard wrapper;
- Global CSS or other top-level imports from the main/entry file should be kept (e.g. import "./globals.css" or similar). Import its exactly how it was in original files;
${REACT_ROUTER_RULE}
Files content:
\`\`\`
${filesContent}
\`\`\`
`;

  return prompt;
};

export const CONVERT_COMPONENT_SYSTEM_PROMPT = `
${GLOBAL_SYSTEM_PROMPT}
Next.js Rules:
${ROOT_IMPORT_RULE}
${USE_CLIENT_RULE}
${NEXTJS_LINK_RULE}
${NEXTJS_IMAGE_RULE}
`;

interface ConvertComponentPromptProps {
  fileContent: string;
  isAuthProtected: boolean;
  authProtectedComponent?: { path: string; fullImportStatement: string } | null;
  projectStructure: string;
}

// Prompt to convert a single Vite component file to a Next.js component file.
export const convertComponentPrompt = ({
  fileContent,
  isAuthProtected,
  authProtectedComponent,
  projectStructure,
}: ConvertComponentPromptProps) => {
  const AUTH_PROTECTED_RULE =
    isAuthProtected && authProtectedComponent
      ? `- This route/component is auth protected. Wrap the exported content with the auth protection component from "${authProtectedComponent.path.replace(/\\/g, "/")} and dont forget to add exact import like this "${authProtectedComponent.fullImportStatement}"\n`
      : "";

  const prompt = `
    Task:
    You are converting a single Vite component file to a Next.js component file.
    Rules: 
    - If file uses Vite env vars, rewrite them to Next.js (process.env / NEXT_PUBLIC_*)
    - When updating component imports, use the project structure to determine the exact import path.
    ${AUTH_PROTECTED_RULE}
    File content:
    \`\`\`
    ${fileContent}
    \`\`\`
    - Project structure:
    \`\`\`
    ${projectStructure}
    \`\`\`
  `;

  return prompt;
};

// Prompt to convert a postcss.config.js file from Vite to Next.js.
export const convertPostCSSFilePrompt = (fileContent: string) => {
  const prompt = `
    Task:
    You are converting a postcss.config.js file from Vite to Next.js.
    Rules:
    - Preserve the intent of the config and key value pairs.
    - The output must be a single module.exports of an object that has a "plugins" key. Convert any PostCSS plugins from the source to their Next.js equivalents. 
    File content: 
    \`\`\`
    ${fileContent}
    \`\`\`
    `;

  return prompt;
};

// Prompt to analyze the index file and return the routes and auth protected component.
export const analyzeIndexFilePrompt = (fileContent: string) => {
  const prompt = `
      You are analyzing a React + Vite entry file that uses react-router-dom (Routes, Route).
      Your task: list every route that is actually used in this file.
  
      Do not infer or guess routes. Only include routes explicitly defined in this file.
      For each <Route path="..." element={...} />, return:
      - path: the route path string (e.g. "/", "/auth", "/components/:slug")
      - component: the name of the actual page component used for that route (the component that renders the page content). If the element is a wrapper (e.g. ProtectedRoute) that wraps another component, use the innermost page component (e.g. ComponentShowcase, Auth, NotFound), not the wrapper.
      - isProtected: whether the route is protected by a ProtectedRoute or similar component.
      - importPath: the exact module path from the import statement for this component — the string that appears after "from" in the import line for this component (e.g. "./pages/about/CustomerCare", "./pages/about/testing/again/index"). Copy it exactly as in the file, including leading "./" if present.
      - authProtectedComponent: only if at least one route is protected. Return an object with:
        - path: the module path/specifier as used in the import (e.g. "@/components/AuthProtectedRoute").
        - fullImportStatement: the exact, complete import line as it appears in this file — copy the full line character-for-character, including "import", the specifier (default or named, e.g. { ProtectedRoute } or DefaultName), "from", and the module path with semicolon. Example: import { AuthProtectedRoute } from "@/components/AuthProtectedRoute";
  
      Ignore redirect-only routes if they have no real page component; otherwise include them with the component that handles them.
      Return strictly JSON: { "routes": [ { "path": "...", "component": "ComponentName", "isProtected": true|false, "importPath": "./pages/..." }, ... ], "authProtectedComponent": { "path": "...", "fullImportStatement": "import ... from \\"...\\";" } or null if no protected routes }
      File content:
      \`\`\`
      ${fileContent}
      \`\`\`
      `;

  return prompt;
};

export interface PostConversionIssueForPrompt {
  type: string;
  file: string;
  message: string;
}

// Prompt to fix only the listed post-conversion errors/warnings in a file.
export const fixPostConversionIssuesPrompt = (
  fileContent: string,
  filePath: string,
  issues: PostConversionIssueForPrompt[],
): string => {
  const issuesList = issues.map((i) => `- [${i.type}] ${i.message}`).join("\n");
  return `
Task:
Fix ONLY the following issues in this file. Do not change any other code, formatting, or behavior.

File: ${filePath}

Issues to fix:
${issuesList}

Rules:
- Apply minimal edits to resolve each issue.
- Do not refactor, add features, or change anything unrelated to the issues above.
- Output the ENTIRE file content with only those fixes applied.
- Do not include markdown fences or any text before/after the code.

Current file content:
\`\`\`
${fileContent}
\`\`\`
`;
};
