export interface EntryFile {
  /** Route path */
  path: string;
  /** Module specifier → names imported from it (e.g. "react-router-dom" → ["Link", "useNavigate"]) */
  importsByModule: Record<string, string[]>;
  /** Exported names (including "default" if default export) */
  exports: string[];
}

export interface FileInfo extends EntryFile {
  /** Component name */
  component: string;
  /** Source file path */
  sourceFile: string;
  /** Always true for now; later may suroute pport server components */
  //   client: boolean;
  /** Path relative to next-output/{jobId}, e.g. "app/page.tsx" or "components/dashboard/DateRangeSelector.tsx" */
  outputFile: string;
  /** Whether to send to AI for conversion */
  shouldSendToAi: boolean;
  /** Whether the score has been calculated for AI conversion */
  isScoreCalculated: boolean;
  /** Whether the route is auth protected by a ProtectedRoute or similar component */
  isAuthProtected: boolean;
}

export interface AnalysisResult {
  //   framework: "react-vite";
  //   router: "react-router" | "unknown";
  /** Entry and layout files for the project. They need to go into analysis stage so their imports are copied ( if any ). All files are sent at same time to AI at convert stage so they are combined into single entry file for output project. */
  entryFiles: EntryFile[];
  /** Routes */
  routes: FileInfo[];
  /** Component files */
  componentFiles: FileInfo[];
  /**
   * Per-file metadata (FileInfo[]) only for code files. Extra javascript/typescript files that are not routes or components from root/src directory. Used for AI conversion.
   *
   */
  extraLogicFilesRoot: FileInfo[];
  extraLogicFilesSrc: FileInfo[];
  /**
   * Files and folders in root/src directory that should be copied to output
   * Plain names (strings) of top-level entries (files or folders) in the repo root and in src/, from a simple directory listing (with exclusions).
   */
  extraRootFilesFolders: string[];
  extraSrcFilesFolders: string[];
  /** Dependencies from package.json */
  dependencies: Record<string, string>;
  /** Dev dependencies from package.json */
  devDependencies: Record<string, string>;
  /** Output project folder structure */
  projectStructure: string;
  /** Auth protected component: path for resolution and exact full import line for use in generated code */
  authProtectedComponent?: {
    /** Module path (e.g. "@/components/ProtectedRoute") for resolving the file */
    path: string;
    /** Exact full import statement as it appears in the index file. Needed because AI may use missmatch default and named imports (e.g. 'import { ProtectedRoute } from "@/components/ProtectedRoute";') */
    fullImportStatement: string;
  } | null;
}

export interface MigrationPlan {
  routingStrategy: "next-app-router";
  //   routeMappings: Array<{
  //     from: string;
  //     to: string;
  //     file: string;
  //   }>;
  layoutStrategy: string;
  assumptions: string[];
  risks: string[];
}
