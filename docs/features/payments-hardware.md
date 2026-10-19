# Payments and hardware

## Payment architecture

Port: `PaymentsPort` in `modules/payments`; one adapter per provider. Adapters live in `packages/payments-adapters/<provider>` so new providers do not touch core.

```ts
interface PaymentAdapter {
  capabilities: { cardPresent: boolean; online: boolean; qr: boolean; refunds: boolean; partialRefunds: boolean; offlineStoreAndForward: boolean; currencies: string[] };
  createIntent(input: CreateIntent): Promise<Intent>;   // amount, currency, reference = sale/order id
  confirm?(intentId: string, data: unknown): Promise<Intent>;
  cancel(intentId: string): Promise<void>;
  refund(paymentId: string, amountMinor: bigint): Promise<Refund>;
  parseWebhook(req: Request, secret: string): Promise<GatewayEvent>; // verifies signature first
}
```

| Tender | Flow | Notes |
|---|---|---|
| Cash | Local only | Change calculation, cash rounding per currency (to 0.05 etc.), drawer kick |
| Card (in store) | Semi-integrated terminal: app sends amount → terminal handles card → result + token | PCI scope stays with the terminal. Adapters for regional acquirers + Stripe Terminal / Adyen / SumUp class providers |
| Card (online) | Hosted fields, redirect, or payment link | 3DS handled by gateway |
| QR | Dynamic QR (amount + reference) per country scheme (e.g. LankaQR, UPI, PayNow, PIX) → webhook or poll confirms | Online only |
| Payment link | Shortlink → hosted checkout | Orders, deposits |
| Store credit / voucher | Internal ledger | Offline with cap |
| Loyalty points | Points → value at tenant rate | Offline with cap |
| Split | Any combination; remaining balance shown; partial reversals on cancel | |
| Reservation / deposit | Partial capture now, remainder at pickup | P2 |

Intent states: `created → pending → succeeded | failed | canceled`. Refunds are separate records. Every transition is stored in `payment_events` (append-only). A daily reconciliation job matches gateway settlement reports against our records; mismatches create tasks.

## Hardware support

All device I/O goes through `@wise-biz/hardware` ports. Implementations per platform:

| Device | Electron (desktop) | Android | iOS | Web |
|---|---|---|---|---|
| Receipt printer (ESC/POS 58/80 mm) | USB, serial, network (TCP 9100) | Bluetooth, USB OTG, network | Bluetooth (MFi/BLE printers), network | Network via local bridge, WebUSB (Chromium) |
| Label printer (ZPL/TSPL) | USB, network | Network, Bluetooth | Network | WebUSB |
| Barcode scanner 1D/2D | HID keyboard wedge, serial | HID, camera (ML Kit), built-in (Sunmi, Zebra intents) | HID (Bluetooth), camera | HID wedge, camera (BarcodeDetector) |
| Cash drawer | Kick via printer (ESC p) or USB | Via printer | Via printer | Via printer |
| Customer display | Second window or serial VFD | Dual-screen API (Sunmi/iMin) | External screen | Second window |
| Scale | Serial (common protocols) | USB/BT | — | WebSerial |
| Payment terminal | Vendor SDK / cloud API | SDK / cloud API | SDK / cloud API | Cloud API |

Scanners: 1D linear and 2D imagers (QR, DataMatrix, PDF417) through HID or camera. GS1 parsing (application identifiers for batch and expiry) lives in `@wise-biz/barcode`, so a scan can fill the batch automatically.

Value indicators (customer-facing price and change displays): the customer display page renders cart, totals, change due, a QR for the digital receipt, and a loyalty prompt, driven by the same cart state over IPC or LAN.

Hardware drivers on React Native come from community libraries. Wrap each behind `@wise-biz/hardware` and test on real devices before committing to one; replace freely.

## Receipts and documents

`@wise-biz/receipt`: one template model → renderers for ESC/POS bytes, HTML (email/digital), PDF (A4 invoices, quotations, letterhead).

Template blocks: logo, letterhead, header text, store details, tax IDs, lines table, discounts, tax summary, tenders, change, loyalty balance, barcode/QR (digital receipt shortlink), footer, special notes per sale, custom fields. Per-branch overrides. Console preview uses real sample data.

Letterheads: upload (PDF/PNG/SVG via media-kit) or build in the template editor; used for A4 invoices, quotations, and statements.

## Barcodes

- Formats: EAN-13/8, UPC-A/E, Code128, Code39, QR, DataMatrix, GS1-128.
- Custom barcode products: in-store EAN-13 with prefix 20–29 encoding SKU + weight or price; parser rules configurable per tenant.
- Barcode generation and label printing for products without manufacturer codes; batch label printing after receiving.

## Keyboard and touch

- Default keymap (configurable per tenant/terminal): `F1` search, `F2` qty, `F3` discount, `F4` customer, `F8` park, `F9` pay, `F10` exact cash, `Esc` back one step, `+/-` qty, numpad first-class.
- Command palette (`Ctrl/Cmd+K`) on desktop and tablets with keyboards.
- Touch targets ≥ 48 dp (≥ 56 dp on primary checkout actions), thumb-zone layout on phones, no hover-only affordances.
