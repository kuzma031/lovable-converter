export function routePathToAppDir(routePath: string): string {
  if (routePath === "/") return "";

  return routePath
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      if (segment.startsWith(":")) {
        return `[${segment.slice(1)}]`;
      }
      return segment;
    })
    .join("/");
}
