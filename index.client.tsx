import type { PluginClientContext } from "@getpaseo/plugin/client";
import { bindPluginLanguage } from "./client/i18n";
import { t } from "./shared/text";
import { RemoteHostScreen, RemoteHostSidebarItem } from "./client/remote-host";

/**
 * The whole plugin is client side. It reads other hosts through the connections the app already holds
 * (`getPaseoClient`), so there is no server entry, no daemon hook and nothing to install on the remote machine.
 * The screen is registered directly rather than through a lazily loaded chunk, so there is no build artifact that
 * has to be kept in step with the source.
 */
export default function contribute(client: PluginClientContext) {
  bindPluginLanguage();
  const cleanups = [
    client.addScreen({ id: "remote-host", title: () => t("boot.remoteTitle"), Component: RemoteHostScreen }),
    client.addSidebarHeaderItem({ id: "remote-host", title: t("boot.remoteTitle"), Component: RemoteHostSidebarItem }),
    client.addCommandCenterItem({ id: "open-remote-host", title: t("boot.openRemote"), icon: "Satellite", context: "global",
      onSelect(context) { context.openScreen({ screenId: "remote-host" }); } }),
  ];
  return () => { for (const cleanup of cleanups.splice(0)) { try { cleanup(); } catch { /* the host is tearing down already */ } } };
}
