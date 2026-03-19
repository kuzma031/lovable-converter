import { parse } from "@babel/parser";

export function parseTSX(code: string) {
  return parse(code, {
    sourceType: "module",
    plugins: ["typescript", "jsx"],
  });
}
