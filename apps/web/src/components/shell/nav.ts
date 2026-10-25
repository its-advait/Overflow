import type { LucideIcon } from "lucide-react";
import {
  Activity,
  BookOpenText,
  Bot,
  LayoutDashboard,
  Settings,
  ShoppingBag,
  Target,
} from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  /** One line from the spec about what the page shows. */
  description: string;
  icon: LucideIcon;
}

/** One list drives the sidebar and the placeholder pages. Order is the sidebar order. */
export const NAV: readonly NavItem[] = [
  {
    href: "/",
    label: "Overview",
    description: "Treasury balance, budget utilization and what the agents are doing right now.",
    icon: LayoutDashboard,
  },
  {
    href: "/missions",
    label: "Missions",
    description: "Compose a mission, extract its requirements and follow its purchases.",
    icon: Target,
  },
  {
    href: "/agents",
    label: "Agents",
    description: "The agent tree with each node's cap, spend and pause state read from the treasury.",
    icon: Bot,
  },
  {
    href: "/purchases",
    label: "Purchases",
    description: "Oracle recommendations, Fusion merges and the authorization each agent signed.",
    icon: ShoppingBag,
  },
  {
    href: "/activity",
    label: "Activity",
    description: "Every event in order, including the Blocked lane with decoded revert reasons.",
    icon: Activity,
  },
  {
    href: "/ledger",
    label: "Ledger",
    description: "Double-entry journal reconciled against the chain, split by department.",
    icon: BookOpenText,
  },
  {
    href: "/settings",
    label: "Settings",
    description: "Seller behaviour, prices, agent caps, payees and license flags for the demo.",
    icon: Settings,
  },
];
