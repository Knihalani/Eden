"use client";

import { useAuth, useClerk, useOrganization, useUser } from "@clerk/nextjs";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Suspense,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { ActivityProvider, forgetActivity } from "./activity-context";
import type { Activity } from "./activity";
import { HOME, SEE_PENDING, TOUR, WORKSPACE } from "../account/home";
import { AppNav, useNavCollapsed } from "./nav";
import { BrandMark } from "../brand-mark";
import { forgetAvatar, readCachedAvatar, rememberAvatar, sizedAvatar, type Portrait } from "./portrait";

export function AppChrome({
  children,
  initial,
  portrait,
}: {
  children: ReactNode;
  initial: Activity;
  portrait: Portrait;
}) {
  const router = useRouter();
  const path = usePathname();
  const { orgId, userId } = useAuth(SEE_PENDING);
  const owner = [userId, orgId].filter(Boolean).join(":");
  const workspace = path === WORKSPACE || path.startsWith(`${WORKSPACE}/`);
  const tour = path === TOUR || path.startsWith(`${TOUR}/`);
  const home = path === HOME;
  const canvas = path.startsWith("/live/") || path.startsWith("/request/");
  const slim = workspace || tour;
  const { collapsed, ready, onToggle } = useNavCollapsed();

  useEffect(() => {
    if (!home || !orgId) return;
    let cancelled = false;
    const start = () => {
      if (cancelled) return;
      router.prefetch(HOME);
      router.prefetch("/home?view=requests");
      router.prefetch("/home?view=workflows");
      router.prefetch("/setup");
    };
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(start);
      return () => {
        cancelled = true;
        window.cancelIdleCallback(id);
      };
    }
    const id = window.setTimeout(start, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
  }, [router, home, orgId]);

  return (
    <ActivityProvider initial={initial} owner={owner} quiet={slim || canvas}>
      <div className="app">
        <header className="app-bar">
          <Link
            href={orgId ? HOME : WORKSPACE}
            className="brand"
            aria-label={orgId ? "Eden home" : "Eden"}
            prefetch={true}
          >
            <BrandMark />
            <span className="brand-name">Eden</span>
          </Link>
          <ProfileMenu portrait={portrait} owner={owner} />
        </header>
        {slim ? (
          <main className="app-well" id="content">
            {children}
          </main>
        ) : (
          <div className="app-body" data-nav={collapsed ? "thin" : "wide"} data-nav-ready={ready ? "true" : undefined}>
            <Suspense fallback={<nav className="app-nav" aria-hidden="true" />}>
              <AppNav collapsed={collapsed} onToggle={onToggle} />
            </Suspense>
            <main className={home || canvas ? "app-well app-well-flush" : "app-well"} id="content">
              {children}
            </main>
          </div>
        )}
      </div>
    </ActivityProvider>
  );
}

function ProfileMenu({ portrait, owner }: { portrait: Portrait; owner: string }) {
  const { signOut } = useClerk();
  const { organization } = useOrganization();
  const { user } = useUser();
  const path = usePathname();
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const itemsRef = useRef<Array<HTMLAnchorElement | HTMLButtonElement | null>>([]);
  const pendingFocus = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [photoFailed, setPhotoFailed] = useState(false);
  const [photoReady, setPhotoReady] = useState(false);
  const [cachedPhoto, setCachedPhoto] = useState<string | null>(null);

  const workspace = organization?.name || "Workspace";
  const initial =
    (user?.firstName || user?.username || user?.primaryEmailAddress?.emailAddress || portrait.initial || "E")
      .slice(0, 1)
      .toUpperCase();
  const source = user?.hasImage ? user.imageUrl : portrait.imageUrl;
  const livePhoto = !photoFailed && source ? sizedAvatar(source) : null;
  const photo = livePhoto || (!photoFailed ? cachedPhoto : null);

  useLayoutEffect(() => {
    setCachedPhoto(readCachedAvatar(owner));
  }, [owner]);

  useEffect(() => {
    if (photo && owner) rememberAvatar(photo, owner);
  }, [photo, owner]);

  useEffect(() => {
    setPhotoFailed(false);
    setPhotoReady(false);
  }, [source]);

  const close = useCallback(() => {
    setOpen(false);
    buttonRef.current?.focus();
  }, []);

  useEffect(() => {
    setOpen(false);
  }, [path]);

  useEffect(() => {
    if (!open || pendingFocus.current == null) return;
    const index = pendingFocus.current;
    pendingFocus.current = null;
    const items = itemsRef.current.filter(Boolean);
    const item = items[(index + items.length) % items.length];
    item?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);

  const focusItem = (index: number) => {
    const items = itemsRef.current.filter(Boolean);
    const item = items[(index + items.length) % items.length];
    item?.focus();
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = itemsRef.current.filter(Boolean);
    const index = items.findIndex((item) => item === document.activeElement);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusItem(index + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusItem(index - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusItem(0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusItem(items.length - 1);
    }
  };

  const onButtonKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    pendingFocus.current = event.key === "ArrowUp" ? -1 : 0;
    setOpen(true);
  };

  return (
    <div className="profile" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="profile-btn"
        aria-label="Account"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={onButtonKeyDown}
      >
        <span className="profile-face">
          <span className="profile-letter" aria-hidden="true">
            {initial}
          </span>
          {photo ? (
            <img
              src={photo}
              alt=""
              width={40}
              height={40}
              decoding="async"
              referrerPolicy="no-referrer"
              className={photoReady ? "is-ready" : undefined}
              data-ready={photoReady ? "true" : "false"}
              onLoad={() => setPhotoReady(true)}
              onError={() => {
                setPhotoFailed(true);
                setCachedPhoto(null);
                forgetAvatar();
              }}
            />
          ) : null}
        </span>
      </button>
      {open ? (
        <div
          id={menuId}
          className="profile-menu"
          role="menu"
          aria-label="Account"
          onKeyDown={onMenuKeyDown}
        >
          <Link
            ref={(node) => {
              itemsRef.current[0] = node;
            }}
            href={WORKSPACE}
            role="menuitem"
            prefetch={true}
            aria-current={path === WORKSPACE || path.startsWith(`${WORKSPACE}/`) ? "page" : undefined}
            onClick={() => setOpen(false)}
          >
            {workspace}
          </Link>
          <div className="profile-rule" role="separator" />
          <button
            ref={(node) => {
              itemsRef.current[1] = node;
            }}
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              forgetAvatar();
              forgetActivity();
              void signOut({ redirectUrl: "/" });
            }}
          >
            Sign out
          </button>
        </div>
      ) : null}
    </div>
  );
}
