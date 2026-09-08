export type OpenPetsControlCenterRoute = "dashboard" | "pets" | "integrations" | "plugins" | "settings";

export type OpenPetsDesktopAction =
  | { readonly type: "open-control-center"; readonly route: OpenPetsControlCenterRoute }
  | { readonly type: "toggle-default-pet" }
  | { readonly type: "toggle-default-pet-paused" };

const routes = new Set<OpenPetsControlCenterRoute>(["dashboard", "pets", "integrations", "plugins", "settings"]);

export function parseOpenPetsDesktopAction(argv: readonly string[]): OpenPetsDesktopAction | null {
  const actions = argv.flatMap((arg): OpenPetsDesktopAction[] => {
    if (arg === "--open-control-center") return [{ type: "open-control-center", route: "dashboard" }];
    if (arg.startsWith("--open-control-center=")) {
      const route = arg.slice("--open-control-center=".length) as OpenPetsControlCenterRoute;
      return routes.has(route) ? [{ type: "open-control-center", route }] : [];
    }
    if (arg === "--toggle-default-pet") return [{ type: "toggle-default-pet" }];
    if (arg === "--toggle-default-pet-paused") return [{ type: "toggle-default-pet-paused" }];
    return [];
  });
  return actions.length === 1 ? actions[0] : null;
}
