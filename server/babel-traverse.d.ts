declare module "@babel/traverse" {
  import type { Node } from "@babel/types";
  export interface NodePath<T extends Node = Node> {
    node: T;
  }
  function traverse(
    ast: Node,
    visitors: Record<string, (path: NodePath<any>) => void>
  ): void;
  export default traverse;
  export type { NodePath };
}
