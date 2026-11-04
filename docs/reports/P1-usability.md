# P1 usability sessions: script and metric sheet

For P1-16 check 8. The owner runs the sessions; this file is the script and the sheet to fill in. Source of the targets: `PRODUCT.md` (Success metrics) and `docs/design/ux.md` (Research and validation).

## Who and how

- 5 cashiers and 3 owners, across store types (grocery, pharmacy, apparel, restaurant). Aim for at least one of each type.
- 45 minutes per person, one facilitator and one note-taker. Record screen and audio with consent; store recordings outside the repo and never put customer or card data in notes.
- Cashiers use the POS app on the device class they would own (low-end Android, mid-range Windows PC). Owners use the console on their own laptop or phone.
- Say "think aloud". Do not help unless the participant is stuck for 60 s; then give the smallest hint and mark the task "assisted".
- Use the demo business (`scripts/seed-demo.mts`), never a real one.

## Cashier tasks (POS)

Measure time from the first touch to the end state. Mark pass, assisted or fail.

| # | Task | End state | Target |
|---|---|---|---|
| C1 | Sell 10 items by scan, pay cash, print the receipt | Receipt started | ≤ 30 s |
| C2 | Sell one item found by search (no barcode) | Line in the cart | ≤ 15 s |
| C3 | Split tender: part cash, part card | Sale complete, change shown | ≤ 45 s |
| C4 | Return one item with the receipt | Refund recorded | ≤ 60 s |
| C5 | Void the last sale | Sale voided, reason given | ≤ 30 s |
| C6 | Price check without selling | Price read out | ≤ 10 s |
| C7 | Sell with the network switched off | Sale completes, "unsent" shown | no extra steps |
| C8 | Reconnect and find out whether everything was sent | Participant says it is | answered correctly |
| C9 | Close the shift and count the drawer | Z-report shown | ≤ 3 min |

## Owner tasks (console)

| # | Task | End state | Target |
|---|---|---|---|
| O1 | Sign up and make the first sale | First sale on a terminal | ≤ 15 min from signup |
| O2 | Import a product list from a CSV | Products visible | ≤ 5 min |
| O3 | Receive a delivery of 3 products | Stock shows the new quantities | ≤ 3 min |
| O4 | Enrol a new terminal | Terminal shown online | ≤ 3 min |
| O5 | Find today's sales and compare with last week | Participant states the difference | ≤ 1 min |
| O6 | Find who sold the most this week | Name or id read out | ≤ 1 min |
| O7 | Turn on the daily email and phone push | Preferences saved | ≤ 1 min |
| O8 | Change the brand colour and publish it | Theme published | ≤ 3 min |
| O9 | Revoke a lost terminal | Terminal revoked | ≤ 1 min |
| O10 | Download last month's sales as CSV | File downloaded | ≤ 2 min |

## After each task (1 to 5)

- Single Ease Question: "Overall, how easy was this task?" (1 very difficult, 5 very easy).
- Open: "What did you expect to happen?"

## After the session

- System Usability Scale (10 questions), scored 0 to 100.
- "What would you stop using this for first, and why?"
- "What would make you trust it with a busy Saturday?"

## Metric sheet (one row per participant and task)

| Participant | Role | Store type | Device | Task | Time (s) | Result (pass / assisted / fail) | Errors | SEQ | Notes |
|---|---|---|---|---|---|---|---|---|---|
| | | | | | | | | | |

## Pass bar for the gate

- Cashier tasks C1 to C6: at least 4 of 5 cashiers pass unassisted, median time within target.
- C7 and C8: 5 of 5 understand that an offline sale is saved and whether it was sent.
- Owner tasks O1 to O5: at least 2 of 3 owners pass unassisted.
- Median SUS at least 80 (good) and no participant under 68.
- Any "fail" on C1, C7, C9 or O9 is a blocker, whatever the other results.

## In-app measures to read from the demo business afterwards

Steps per sale, errors per 100 sales, override frequency, and the search-to-scan ratio (`docs/design/ux.md`). Note: the POS does not record these yet. If the numbers are missing, count them from the screen recordings and say so in the gate report.
