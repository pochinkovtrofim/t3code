import { listManagedProjectGroups } from "../components/sidebar/projectGroups.logic";
import { useServerConfigs, useThreadShells } from "../state/entities";
import { useSidebarProjectGroups } from "./useSidebarProjectGroups";

export function useManagedProjectGroups() {
  const groups = useSidebarProjectGroups();
  const threads = useThreadShells();
  const serverConfigs = useServerConfigs();
  return listManagedProjectGroups({ groups, threads, serverConfigs });
}
