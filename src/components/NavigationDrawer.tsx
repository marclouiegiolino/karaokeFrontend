"use client";

import { useEffect, useRef } from "react";
import { User } from "@/lib/api";
import { AppView, DrawerActionId, DrawerItem, getDrawerItems } from "@/lib/uiState";
import styles from "@/app/page.module.css";

type NavigationDrawerProps = {
  open: boolean;
  user: User;
  activeView: AppView;
  queueCount: number;
  onClose: () => void;
  onSelectView: (view: AppView) => void;
  onSignOut: () => void;
};

export function NavigationDrawer({
  open,
  user,
  activeView,
  queueCount,
  onClose,
  onSelectView,
  onSignOut,
}: NavigationDrawerProps) {
  const panelRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  const items = getDrawerItems(user.role);

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previousFocusRef.current?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  function handleItemClick(item: DrawerItem) {
    if (item.id === "sign-out") {
      onClose();
      onSignOut();
      return;
    }
    if (item.view) {
      onSelectView(item.view);
      onClose();
    }
  }

  function badgeForItem(id: DrawerActionId): string | null {
    if (id === "queue" && queueCount > 0) return String(queueCount);
    if (id === "manage-songs") return "ADMIN";
    return null;
  }

  return (
    <div
      className={styles.drawerBackdrop}
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside
        ref={panelRef}
        id="nav-drawer"
        className={styles.drawerPanel}
        role="dialog"
        aria-modal="true"
        aria-label="Navigation menu"
      >
        <div className={styles.drawerHeader}>
          <div className={styles.drawerUser}>
            <span className={styles.avatar} aria-hidden="true">
              {user.display_name.slice(0, 1).toUpperCase()}
            </span>
            <div className={styles.drawerUserMeta}>
              <strong>{user.display_name}</strong>
              <small>
                @{user.username} · {user.role}
              </small>
            </div>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className={styles.iconButton}
            onClick={onClose}
            aria-label="Close navigation menu"
          >
            ×
          </button>
        </div>

        <nav className={styles.drawerNav} aria-label="Primary drawer navigation">
          {items.map((item) => {
            const isActive = item.view === activeView;
            const badge = badgeForItem(item.id);
            const isDanger = item.id === "sign-out";
            return (
              <button
                key={item.id}
                type="button"
                className={`${styles.drawerItem} ${isActive ? styles.drawerItemActive : ""} ${
                  isDanger ? styles.drawerItemSignOut : ""
                }`}
                aria-current={isActive ? "page" : undefined}
                onClick={() => handleItemClick(item)}
              >
                <span className={styles.drawerItemBody}>
                  <strong>{item.label}</strong>
                  <small>{item.description}</small>
                </span>
                {badge && <span className={styles.drawerBadge}>{badge}</span>}
              </button>
            );
          })}
        </nav>
      </aside>
    </div>
  );
}
