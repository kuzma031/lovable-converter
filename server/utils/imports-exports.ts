import fs from "fs";
import path from "path";
import * as ts from "typescript";

export interface ImportsAndExports {
  exports: string[];
  /** Module specifier (e.g. "react", "react-router-dom") → names imported from it */
  importsByModule: Record<string, string[]>;
}

function getScriptKind(filePath: string): ts.ScriptKind {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".tsx":
      return ts.ScriptKind.TSX;
    case ".jsx":
      return ts.ScriptKind.JSX;
    case ".ts":
      return ts.ScriptKind.TS;
    case ".js":
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.Unknown;
  }
}

function getModuleExportNameText(
  node: ts.ModuleExportName,
  sourceFile: ts.SourceFile
): string {
  return ts.isIdentifier(node) ? node.getText(sourceFile) : node.text;
}

function collectExportedDeclarationName(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  out: string[]
): void {
  if (ts.canHaveModifiers(node)) {
    const mods = ts.getModifiers(node);
    if (!mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) return;
    const isDefault = mods.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
    if (isDefault) {
      out.push("default");
      return;
    }
  }
  if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) {
    if (node.name) out.push(node.name.getText(sourceFile));
    return;
  }
  if (
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node)
  ) {
    out.push(node.name.getText(sourceFile));
    return;
  }
  if (ts.isModuleDeclaration(node) && node.name) {
    if (ts.isIdentifier(node.name)) out.push(node.name.getText(sourceFile));
    return;
  }
  if (ts.isVariableStatement(node)) {
    for (const decl of node.declarationList.declarations) {
      if (ts.isIdentifier(decl.name)) out.push(decl.name.getText(sourceFile));
    }
  }
}

/**
 * Extract imports-by-module and exported names from a TS/TSX file using the TypeScript compiler API (syntax-only parse).
 * Returns empty exports and importsByModule on parse error or unsupported file.
 */
export function getImportsAndExports(filePath: string): ImportsAndExports {
  const result: ImportsAndExports = {
    exports: [],
    importsByModule: {},
  };
  try {
    const sourceText = fs.readFileSync(filePath, "utf-8");
    const scriptKind = getScriptKind(filePath);
    const sourceFile = ts.createSourceFile(
      filePath,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      scriptKind
    );

    for (const stmt of sourceFile.statements) {
      if (ts.isImportDeclaration(stmt)) {
        const fromModule = ts.isStringLiteral(stmt.moduleSpecifier)
          ? stmt.moduleSpecifier.text
          : stmt.moduleSpecifier.getText(sourceFile);
        if (!result.importsByModule[fromModule])
          result.importsByModule[fromModule] = [];

        const clause = stmt.importClause;
        if (!clause) continue;
        if (clause.name) {
          result.importsByModule[fromModule].push(
            clause.name.getText(sourceFile),
          );
        }
        const bindings = clause.namedBindings;
        if (bindings) {
          if (ts.isNamespaceImport(bindings)) {
            result.importsByModule[fromModule].push(
              bindings.name.getText(sourceFile),
            );
          } else {
            for (const el of bindings.elements) {
              result.importsByModule[fromModule].push(
                el.name.getText(sourceFile),
              );
            }
          }
        }
        continue;
      }
      if (ts.isExportDeclaration(stmt)) {
        const clause = stmt.exportClause;
        if (!clause) continue; // export * from "mod"
        if (ts.isNamedExports(clause)) {
          for (const el of clause.elements) {
            result.exports.push(getModuleExportNameText(el.name, sourceFile));
          }
        } else {
          result.exports.push(getModuleExportNameText(clause.name, sourceFile));
        }
        continue;
      }
      if (ts.isExportAssignment(stmt)) {
        if (!stmt.isExportEquals) result.exports.push("default");
        continue;
      }
      collectExportedDeclarationName(stmt, sourceFile, result.exports);
    }

    return result;
  } catch {
    return result;
  }
}
