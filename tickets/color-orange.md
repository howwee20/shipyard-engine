# shipyard:ticket
title: "Change brand color from pink to orange (single file)"
why: "Visual smoke to confirm end-to-end loop"
scope:
  - src/app/layout.tsx
dod:
  - "Replace Tailwind pink/fuchsia classes with orange equivalents (e.g., text-orange-500)"
guardrails:
  - "Touch only the file listed in scope"
  - "Keep edits minimal; do not change copy, layout, or other colors"
