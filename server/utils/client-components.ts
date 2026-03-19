import { parseTSX } from "./ast";
import traverseDefault from "@babel/traverse";
import * as t from "@babel/types";

type TraverseFn = (
  ast: t.Node,
  visitors: Record<string, (path: { node: t.Node }) => void>,
) => void;
const traverse: TraverseFn =
  typeof traverseDefault === "function"
    ? traverseDefault
    : (traverseDefault as { default: TraverseFn }).default;

/** React hooks: useXxx where Xxx starts with uppercase (useState, useEffect, etc.) */
const HOOK_NAME_REGEX = /^use[A-Z]/;

/**
 * Returns true only if the file contains at least one React hook call (useState,
 * useEffect, useRef, etc.). Used to decide whether to add 'use client'.
 */
export function usesHooks(source: string): boolean {
  let result = false;
  try {
    const ast = parseTSX(source);
    traverse(ast, {
      CallExpression(path: { node: t.Node }) {
        if (result) return;
        const node = path.node as t.CallExpression;
        const callee = node.callee;
        if (t.isIdentifier(callee) && HOOK_NAME_REGEX.test(callee.name)) {
          result = true;
        }
      },
    });
  } catch {
    return false;
  }
  return result;
}

const USE_CLIENT_SINGLE = "'use client'";
const USE_CLIENT_DOUBLE = '"use client"';

function hasUseClientDirective(source: string): boolean {
  const trimmed = source.trimStart();
  return (
    trimmed.startsWith(USE_CLIENT_SINGLE) ||
    trimmed.startsWith(USE_CLIENT_DOUBLE)
  );
}

/**
 * Adds 'use client' at the top only when the file uses at least one React hook.
 * If the file has no hooks or already has the directive, returns source unchanged.
 */
export function ensureClientDirective(source: string): string {
  if (hasUseClientDirective(source)) {
    return source;
  }
  if (!usesHooks(source)) {
    return source;
  }
  return `${USE_CLIENT_SINGLE};\n\n${source}`;
}

/**
 * Prepends 'use client' if the file does not already have it. Use for paths that
 * are always client (e.g. components/ui shadcn components) regardless of hooks.
 */
export function prependClientDirectiveIfMissing(source: string): string {
  if (hasUseClientDirective(source)) {
    return source;
  }
  return `${USE_CLIENT_SINGLE};\n\n${source}`;
}
