// bb-plugin-claude-accounts — frontend entry.

import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { AccountsPage } from "./accounts-page";
import { NavigateBridge, openAccountsPage } from "./lib/navigate-bridge";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "claude-accounts",
    title: "Fast Switch Accounts",
    icon: "Users",
    path: "accounts",
    component: AccountsPage,
  });

  // Renders nothing; it only keeps the navigator reachable from the footer.
  app.slots.experimental_appOverlay({
    id: "navigate-bridge",
    component: NavigateBridge,
  });

  app.experimental_sidebarFooter.register({
    kind: "action",
    id: "accounts",
    label: "Fast Switch Accounts",
    icon: "Users",
    onActivate: ({ openPluginDetails }) => {
      if (!openAccountsPage()) openPluginDetails();
    },
  });
});
