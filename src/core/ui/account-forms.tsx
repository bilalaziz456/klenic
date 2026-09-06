"use client";

/**
 * The self-service account forms — avatar, profile, discount-approval switch and
 * password. Shared by three route groups (`/account`, `/admin/account`,
 * `/clinic/settings`), which is why they live in `core/ui` rather than in any one
 * panel (ADR-019).
 *
 * The actions they call live in `core/account/actions.ts`, NOT in `app/account`.
 * That move is what makes this component legal: while they sat in a route group,
 * importing them here was a `core → app` edge (architecture §3), and pushing them in
 * as props instead only moved the problem — `/admin` and `/clinic` then imported from
 * `/account`, i.e. a route group used as a library, which ADR-019 holds at zero. A
 * Server Action several panels share belongs in core, the same way `endImpersonation`
 * does.
 */
import {
  useActionState,
  useEffect,
  useRef,
  useState,
  useTransition,
} from "react";
import { UserRound } from "lucide-react";
import {
  updateMyProfile,
  changeMyPassword,
  uploadMyAvatar,
  removeMyAvatar,
  updateMyDiscountApproval,
  type AccountActionState,
} from "@/core/account/actions";
import { Button } from "@/core/ui/button";
import { Input } from "@/core/ui/input";
import { Label } from "@/core/ui/label";
import { PasswordInput } from "@/core/ui/password-input";
import { Toast } from "@/core/ui/toast";
import { STAFF_PREFIXES } from "@/core/types/auth";
import { syncChecked } from "@/core/ui/checkbox-sync";

const selectCls =
  "h-8 w-24 shrink-0 rounded-lg border border-input bg-[var(--input-bg)] pl-2.5 pr-8 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 select-chevron";

function useToast(state: AccountActionState) {
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (state.saved || state.error) setNonce((n) => n + 1);
  }, [state]);
  return nonce;
}

const CROP_VIEWPORT = 256; // on-screen square crop box (px)
const CROP_OUTPUT = 512; // saved image size (px, square)
const MAX_SOURCE_BYTES = 2 * 1024 * 1024; // 2 MB source image limit

/**
 * Avatar with an inline square CROPPER. Pick an image → drag to reposition, use the
 * slider to zoom, then Save — the visible square (shown circular, matching the
 * avatar) is drawn to a 512×512 canvas and uploaded, so every avatar is a
 * consistent square regardless of the source aspect ratio.
 */
export function AvatarForm({
  initials,
  hasAvatar,
  version,
}: {
  initials: string;
  hasAvatar: boolean;
  version: string;
}) {
  const [state, formAction, pending] = useActionState<AccountActionState, FormData>(
    uploadMyAvatar,
    {},
  );
  const [, startTransition] = useTransition();
  const nonce = useToast(state);
  const [showAvatar, setShowAvatar] = useState(hasAvatar);
  // A local error (e.g. file too big) that isn't a server action result.
  const [localError, setLocalError] = useState<string | null>(null);
  const [localNonce, setLocalNonce] = useState(0);
  // Cache-buster so the preview refetches immediately after a new upload.
  const [bust, setBust] = useState(0);
  const src = `/api/me/avatar?v=${encodeURIComponent(version)}${bust ? `&b=${bust}` : ""}`;

  // Cropper state (only while an image is selected).
  const [imgSrc, setImgSrc] = useState<string | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [natural, setNatural] = useState({ w: 0, h: 0 });
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  const coverScale =
    natural.w && natural.h
      ? Math.max(CROP_VIEWPORT / natural.w, CROP_VIEWPORT / natural.h)
      : 1;
  const scale = coverScale * zoom;
  const imgW = natural.w * scale;
  const imgH = natural.h * scale;

  const clamp = (o: { x: number; y: number }) => ({
    x: Math.min(0, Math.max(CROP_VIEWPORT - imgW, o.x)),
    y: Math.min(0, Math.max(CROP_VIEWPORT - imgH, o.y)),
  });

  // Re-centre / re-clamp when the zoom changes.
  useEffect(() => {
    setOffset((o) => clamp(o));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom]);

  // Close the cropper once the upload succeeds, and refresh the preview.
  useEffect(() => {
    if (state.saved) {
      resetCropper();
      setShowAvatar(true);
      setBust(Date.now());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.saved]);

  function resetCropper() {
    setImgSrc((cur) => {
      if (cur) URL.revokeObjectURL(cur);
      return null;
    });
    setZoom(1);
    setOffset({ x: 0, y: 0 });
    setNatural({ w: 0, h: 0 });
  }

  function pickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file later
    if (!f) return;
    if (f.size > MAX_SOURCE_BYTES) {
      setLocalError("Image must be under 2 MB.");
      setLocalNonce((n) => n + 1);
      return;
    }
    resetCropper();
    setImgSrc(URL.createObjectURL(f));
  }

  function onImgLoad(e: React.SyntheticEvent<HTMLImageElement>) {
    const el = e.currentTarget;
    const w = el.naturalWidth;
    const h = el.naturalHeight;
    setNatural({ w, h });
    const cs = Math.max(CROP_VIEWPORT / w, CROP_VIEWPORT / h);
    setZoom(1);
    setOffset({ x: (CROP_VIEWPORT - w * cs) / 2, y: (CROP_VIEWPORT - h * cs) / 2 });
  }

  function onPointerDown(e: React.PointerEvent) {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!drag.current) return;
    setOffset(
      clamp({
        x: drag.current.ox + (e.clientX - drag.current.x),
        y: drag.current.oy + (e.clientY - drag.current.y),
      }),
    );
  }
  function onPointerUp() {
    drag.current = null;
  }

  function save() {
    const img = imgRef.current;
    if (!img) return;
    const canvas = document.createElement("canvas");
    canvas.width = CROP_OUTPUT;
    canvas.height = CROP_OUTPUT;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    // Map the viewport square back to source-image pixels.
    const sx = -offset.x / scale;
    const sy = -offset.y / scale;
    const sSize = CROP_VIEWPORT / scale;
    ctx.drawImage(img, sx, sy, sSize, sSize, 0, 0, CROP_OUTPUT, CROP_OUTPUT);
    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        const fd = new FormData();
        fd.append("avatar", new File([blob], "avatar.jpg", { type: "image/jpeg" }));
        // toBlob's callback is outside React's flow, so dispatch in a transition.
        startTransition(() => formAction(fd));
      },
      "image/jpeg",
      0.9,
    );
  }

  return (
    <div className="space-y-4">
      {imgSrc ? (
        <div className="space-y-3">
          <div
            className="relative touch-none overflow-hidden rounded-lg border bg-muted select-none"
            style={{ width: CROP_VIEWPORT, height: CROP_VIEWPORT, maxWidth: "100%" }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              ref={imgRef}
              src={imgSrc}
              alt=""
              onLoad={onImgLoad}
              draggable={false}
              className="absolute cursor-grab active:cursor-grabbing"
              style={{ width: imgW, height: imgH, left: offset.x, top: offset.y, maxWidth: "none" }}
            />
            {/* Circular guide: darkens outside the avatar circle. */}
            <div className="pointer-events-none absolute inset-0 rounded-full shadow-[0_0_0_9999px_rgba(0,0,0,0.45)] ring-2 ring-white/70" />
          </div>

          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground">Zoom</span>
            <input
              type="range"
              min={1}
              max={3}
              step={0.01}
              value={zoom}
              onChange={(e) => setZoom(Number(e.target.value))}
              className="w-48 accent-[var(--primary)]"
              aria-label="Zoom"
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Drag to reposition, zoom to fit. The circle is what patients / staff see.
          </p>

          <div className="flex items-center gap-2">
            <Button type="button" size="sm" onClick={save} disabled={pending || !natural.w}>
              {pending ? "Saving…" : "Save picture"}
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={resetCropper} disabled={pending}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <div className="flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-full border bg-muted">
            {showAvatar ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={src}
                alt="Profile picture"
                className="size-full object-cover"
                onError={() => setShowAvatar(false)}
              />
            ) : initials ? (
              <span className="text-lg font-semibold text-muted-foreground">{initials}</span>
            ) : (
              <UserRound className="size-8 text-muted-foreground" aria-hidden="true" />
            )}
          </div>
          <div className="space-y-2">
            <label className="inline-flex cursor-pointer items-center rounded-md border bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground hover:bg-accent/80">
              Choose image
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={pickFile}
                className="sr-only"
              />
            </label>
            {hasAvatar ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="ml-2"
                onClick={() =>
                  startTransition(async () => {
                    await removeMyAvatar();
                    setShowAvatar(false);
                    setBust(Date.now());
                  })
                }
              >
                Remove
              </Button>
            ) : null}
            <p className="text-xs text-muted-foreground">JPG, PNG or WebP, up to 2 MB.</p>
          </div>
        </div>
      )}
      <Toast
        message={
          localError ?? (state.saved ? "Picture updated." : state.error ?? null)
        }
        variant={localError || state.error ? "error" : "success"}
        token={nonce + localNonce}
      />
    </div>
  );
}

/** Edit name, title and email. */
export function ProfileForm({
  prefix,
  fullName,
  email,
  username,
}: {
  prefix: string | null;
  fullName: string | null;
  email: string | null;
  username: string;
}) {
  const [state, formAction, pending] = useActionState<AccountActionState, FormData>(
    updateMyProfile,
    {},
  );
  const nonce = useToast(state);
  // Controlled — avoids the Base UI uncontrolled-FieldControl warning on re-render.
  const [nameVal, setNameVal] = useState(fullName ?? "");
  const [emailVal, setEmailVal] = useState(email ?? "");

  return (
    <form action={formAction} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="fullName">Full name</Label>
          <div className="flex gap-2">
            <select
              name="prefix"
              aria-label="Title"
              defaultValue={prefix ?? ""}
              className={selectCls}
            >
              <option value="">Title</option>
              {STAFF_PREFIXES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <Input
              id="fullName"
              name="fullName"
              value={nameVal}
              onChange={(e) => setNameVal(e.target.value)}
              className="flex-1"
              required
            />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" type="email" value={emailVal} onChange={(e) => setEmailVal(e.target.value)} />
        </div>
      </div>
      <div className="space-y-1">
        <Label className="text-muted-foreground">Username</Label>
        <p className="text-sm">{username}</p>
        <p className="text-xs text-muted-foreground">
          Your login username is managed by your clinic admin.
        </p>
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Save profile"}
      </Button>
      <Toast
        message={state.saved ? "Profile saved." : state.error ?? null}
        variant={state.error ? "error" : "success"}
        token={nonce}
      />
    </form>
  );
}

/**
 * A doctor's own "discounts need approval" switch (mirrors the clinic-admin control
 * on the staff page; either can change it). Saves on toggle.
 */
export function DiscountApprovalForm({
  discountNeedsApproval,
}: {
  discountNeedsApproval: boolean;
}) {
  const [state, formAction, pending] = useActionState<AccountActionState, FormData>(
    updateMyDiscountApproval,
    {},
  );
  const nonce = useToast(state);
  const [needsApproval, setNeedsApproval] = useState(discountNeedsApproval);

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="discountNeedsApproval" value={needsApproval ? "on" : ""} />
      <label className="flex min-h-6 items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={needsApproval}
          ref={syncChecked(needsApproval)}
          onChange={(e) => setNeedsApproval(e.target.checked)}
          className="size-4 accent-[var(--color-primary)]"
        />
        Discounts taken from my share need my approval
      </label>
      <p className="text-xs text-muted-foreground">
        When on, a discount that reduces your earnings waits for your approval before
        it applies.
      </p>
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Saving…" : "Save"}
      </Button>
      <Toast
        message={state.saved ? "Setting saved." : state.error ?? null}
        variant={state.error ? "error" : "success"}
        token={nonce}
      />
    </form>
  );
}

/** Change password (current password required). */
export function PasswordForm() {
  const [state, formAction, pending] = useActionState<AccountActionState, FormData>(
    changeMyPassword,
    {},
  );
  const nonce = useToast(state);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.saved) formRef.current?.reset();
  }, [state.saved]);

  return (
    <form ref={formRef} action={formAction} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="currentPassword">Current password</Label>
        <PasswordInput
          id="currentPassword"
          name="currentPassword"
          autoComplete="current-password"
          required
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="password">New password</Label>
          <PasswordInput
            id="password"
            name="password"
            autoComplete="new-password"
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="confirmPassword">Confirm new password</Label>
          <PasswordInput
            id="confirmPassword"
            name="confirmPassword"
            autoComplete="new-password"
            required
          />
        </div>
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Change password"}
      </Button>
      <Toast
        message={state.saved ? "Password changed." : state.error ?? null}
        variant={state.error ? "error" : "success"}
        token={nonce}
      />
    </form>
  );
}
