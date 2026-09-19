# Launch checklist

Everything between here and both stores. Grouped by what blocks what, not
by store — several items gate others, and two of them cost calendar time
rather than work.

Status as of 2026-09-18. Tick items as they land; add a date when you do,
so a stale "done" is visible.

## Start these first — they cost waiting, not doing

- [ ] **Play closed test: 12 testers, 14 continuous days.** Personal Play
      accounts created after 2023-11-13 can't reach production without it.
      Testers must accept, install *and actually open* the app — Google
      checks engagement now, and rejects a test where nobody used it.
      Two weeks minimum, so start it the day the build is installable.
      ([rules](https://support.google.com/googleplay/android-developer/answer/14151465))
- [ ] **Apple Developer Program** — $99/year, and the Apple ID takes a day
      or two to clear.
- [ ] **Google Play Console** — $25 once.
- [ ] **BIS notification email.** One message, no reply expected, to
      `crypt@bis.doc.gov` and `enc@nsa.gov` with the GitHub URL. Publicly
      available encryption source is not subject to the EAR once notified
      (§742.15(b)), and the compiled binary follows under §740.13(e) — so
      this replaces the annual CSV report. **Only holds while the repo is
      public.** Keep a copy of the sent mail.

## Production environment

Prod has no AWS account yet; staging is 223057859233. See
[INFRASTRUCTURE.md](INFRASTRUCTURE.md).

- [ ] AWS account for prod, root MFA, billing alarm, `mimoza-prod-admin`
      IAM user, access key profile.
- [ ] `server/provision/envs/prod` applied — the modules are written and
      staging-proven, but `envs/prod` has no `cloudfront-signing-key.pub`,
      and `main.tf` reads that file the moment `env_domain` is set. So:
      generate the key pair, then apply, then the certificate validation
      record and the CNAMEs for `api.` and `cdn.`.
- [ ] Apple: **production** APNs key in SSM (staging's is separate — the
      2-key account limit is why).
- [ ] FCM key in SSM. The prod Firebase project (`mimozaapp-1587f`) and
      `app/google-services.json` already exist; the upload waits on the
      account.
- [ ] Google OAuth clients for the prod bundle id; Apple Services ID.
- [ ] `.env.production` locally: `APP_ENV=production`, relay URL, three
      Google client IDs.
- [ ] GitHub `production` environment (role ARN, account id, domain,
      alert email) + OIDC role. The workflow's prod job already exists,
      on `server-v*` tags — commit 5680ce9.

## App build

- [x] `aps-environment` production-only for `APP_ENV=production` — commit
      a356a70.
- [x] `ITSAppUsesNonExemptEncryption: true` — the app carries its own
      ciphers, so the HTTPS exemption doesn't apply.
- [ ] `ios.buildNumber` and `android.versionCode` — both unset in
      `app.json`, and each store rejects a repeat upload of the same one.
      Decide now whether CI bumps them or you do.
- [ ] Play upload key generated and backed up somewhere you'd still have
      after losing the laptop. Losing it means a new listing.
- [ ] Verify Play's current target API floor at submission — it moves
      every August.
- [ ] Build both stores' release artifacts and install them from
      TestFlight / internal testing, not from Xcode.

## Review blockers

- [ ] **Guideline 1.2 (user-generated content).** Photos shared between
      people trigger it. Removing a member and leaving a circle cover
      blocking; there's no report path and no contact address anywhere in
      the app. Minimum: a "Report a problem" mailto in settings. E2EE
      means the relay can't inspect anything, so a report has to be
      submitted from the reporting device — say so in the review notes.
- [ ] **Review notes** walking a reviewer from a fresh Apple ID to a post:
      sign in, create a circle, post a photo. Confirmed solo-reachable, so
      no demo account and no second tester needed — say that explicitly,
      because "we were unable to complete the review" is the default
      outcome when an invite looks required.
- [ ] Consider a standing invite link in the notes anyway, so a reviewer
      can see the multi-person case without a second device.

## Store listings

- [ ] **The website, carrying the three pages the stores need.**
      `joinmimoza.com` is registered but has no DNS records, so nothing
      resolves today. One deploy covers the privacy policy, the support
      contact and the Play deletion page — the three items below are one
      piece of work, not three.
- [ ] Privacy policy, publicly hosted. Required by both, and the App
      Privacy / Data safety answers must match it.
- [ ] Support contact — URL or email, required by both.
- [ ] **Play account deletion URL**: a *web* page where someone can
      request deletion without installing the app. In-app deletion exists
      ([settings.deleteAccount](../app/src/core/i18n/locales/en.json)) but
      Play wants the URL too.
- [ ] App Privacy (Apple) and Data safety (Play): account identifier from
      Apple/Google, push token. Content is E2EE and unreadable by you —
      state it, it's the product.
- [ ] Age rating questionnaires — IARC for Play, Apple's own.
- [ ] Screenshots per device class, Play feature graphic 1024×500, 512×512
      icon, descriptions.

## Already done

- [x] Sign in with Apple — required by 4.8 because Google sign-in exists.
- [x] In-app account deletion, and it erases relay-side content.
- [x] Photo and camera permission strings, specific about why.
- [x] Push permission asked in context, not at launch.
- [x] Staging environment end to end: relay, CDN, alarms, CI/CD.
