// A sidebar-footer action gets no navigation in its context — only
// `openPluginDetails()`, which lands on the Tools page instead of the
// accounts page. Navigation lives in a hook, so an app-wide overlay (mounted
// once per window, allowed to call hooks) parks the navigator here and the
// footer action reads it.

import { useEffect } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";

type ToPluginPanel = (path: string) => void;

let toPluginPanel: ToPluginPanel | null = null;

/** Mounted through `app.slots.experimental_appOverlay`; renders nothing. */
export function NavigateBridge() {
  const navigate = useBbNavigate();
  useEffect(() => {
    toPluginPanel = (path) => navigate.toPluginPanel(path);
    return () => {
      toPluginPanel = null;
    };
  }, [navigate]);
  return null;
}

/** True when the page was opened; false when no window has the bridge yet. */
export function openAccountsPage(): boolean {
  if (toPluginPanel === null) return false;
  toPluginPanel("accounts");
  return true;
}
