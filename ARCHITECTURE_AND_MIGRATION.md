# Architecture, Parity, and Migration Handover

Audit scope: legacy Convex backend at `C:\Users\user\Desktop\washlab-backend-main\washlab-backend-main`, rebuilt Fastify/Postgres backend at this repository, and the attendant, admin, and customer frontend checkouts named below. Frontend repositories were inspected read-only; no frontend files were changed.

**Explicit exclusions:** `drivers` and `maintenanceTickets` are excluded from parity scoring and from the requested import phases. The rebuilt API currently has maintenance routes, but that does not change this exclusion.

## 1. Backend parity audit

| Legacy Convex area / functions | Rebuilt REST surface | Result |
|---|---|---|
| [`branches.ts`](</C:/Users/user/Desktop/washlab-backend-main/washlab-backend-main/convex/branches.ts>): `getActive`, `getById`; [`admin.ts`](</C:/Users/user/Desktop/washlab-backend-main/washlab-backend-main/convex/admin.ts>): branch list/detail/code lookup and CRUD/status/delivery settings | `GET /v1/branches`, `GET /v1/branches/active`, `GET /v1/branches/:id`, `GET /v1/branches/by-code/:code`; admin branch endpoints under `/v1/admin/branches` | Core branch lookup and CRUD are present. Legacy branch country, delivery-option flags, and creator metadata are not represented in the current branch schema. |
| [`admin.ts`](</C:/Users/user/Desktop/washlab-backend-main/washlab-backend-main/convex/admin.ts>): current admin, attendance logs/summary, staff, customer management, order administration, settings, exports, analytics, services, reports, `createAdmin`, `createFirstSuperAdmin` | `/v1/admin/me`, `/staff*`, `/branches/attendance-summary`, `/attendance/logs`, `/customers*`, `/customers/export.csv`, `/orders*`, `/settings`, `/analytics/*`, `/services*`, `/images/upload`, `/reports*` | Attendance filtering, paginated customer CSV export, and a validated base64 image-data-URL upload endpoint are now implemented. Admin profile/report-email preferences, storage-backed image hosting, provisioning, and several analytics/report views remain missing or partial. |
| [`attendants.ts`](</C:/Users/user/Desktop/washlab-backend-main/washlab-backend-main/convex/attendants.ts>): enrollment, email/PIN/password login, biometric verification, attendant sessions, PIN setup, attendance | `/v1/station/login`, `/session`, `/logout`, `/verify-pin`, `/attendance/active`, `/attendance/history`, `/attendance/clock-in`, `/attendance/clock-out`; admin enrollment endpoints under `/v1/admin/staff` | Shared station sessions and PIN clocking are implemented. The legacy individual attendant login/session and biometric enrollment/verification flows, as well as QR clock-in, have no equivalent REST flow. |
| [`stations.ts`](</C:/Users/user/Desktop/washlab-backend-main/washlab-backend-main/convex/stations.ts>): station login/session, stats, orders/details/status/edit, walk-in order, customer search, bag numbers, attendance, activity, transactions, notifications | `/v1/station/*` and `/v1/station/orders*` | Core station workflows exist. The station token moves from Convex arguments into the `x-station-token` header; Convex cursor pagination and IDs also need adaptation. The legacy `checkInOnlineOrder` action has a REST endpoint, but the inspected UI binding was not invoked. |
| [`orders.ts`](</C:/Users/user/Desktop/washlab-backend-main/washlab-backend-main/convex/orders.ts>): public online create and tracking; admin and station order operations | `POST /v1/orders/online`, `GET /v1/orders/track/:orderNumber`, `/v1/admin/orders*`, `/v1/station/orders*` | Main flows map. Request fields and payment/voucher timing differ; see matrix. Legacy `statusHistory` is not imported by the requested script. |
| [`payments.ts`](</C:/Users/user/Desktop/washlab-backend-main/washlab-backend-main/convex/payments.ts>): create/initiate/finalize/reference recovery/history; [`paymentsRecovery.ts`](</C:/Users/user/Desktop/washlab-backend-main/washlab-backend-main/convex/paymentsRecovery.ts>): verify/recover payment and reconciliation | `POST /v1/station/orders/:id/payment`, `POST /v1/station/orders/:id/payment/finalize`, customer payment history, `GET /v1/admin/payments/transactions`, Paystack webhook, station cash reconciliation verification | Admin transaction history is now filtered and paginated. Charge/finalization and webhook paths are present; legacy recovery/status helpers and payloads still need adaptation. |
| [`cashReconciliation.ts`](</C:/Users/user/Desktop/washlab-backend-main/washlab-backend-main/convex/cashReconciliation.ts>), [`cashLedger.ts`](</C:/Users/user/Desktop/washlab-backend-main/washlab-backend-main/convex/cashLedger.ts>): station daily summary/orders/deductions/history, reconciliation/OTP, admin summaries/history/deductions, running ledger/credits | `/v1/station/cash/{summary,orders,deductions,history,reconciliations}`, reconciliation OTP/verify subroutes, `/v1/admin/reconciliation/*` | Main reconciliation and ledger behavior maps. The new flow uses REST references and explicit OTP/verify calls; the old Convex action payloads are not drop-in compatible. Legacy ledger aggregates and reconciliation records are included in the importer. |
| [`dailyReports.ts`](</C:/Users/user/Desktop/washlab-backend-main/washlab-backend-main/convex/dailyReports.ts>): automatic data, drafts, submit, branch/all reports, report detail and outstanding orders | `/v1/station/reports/{auto,draft,submit}` and `/v1/admin/reports*` | Draft/submit and report list/detail have counterparts. Report detail/outstanding-order and older payload fields are not all represented one-for-one. |
| [`analytics.ts`](</C:/Users/user/Desktop/washlab-backend-main/washlab-backend-main/convex/analytics.ts>): dashboard/today stats, top customers, revenue trends, branch performance | `/v1/admin/analytics/{overview,payments,weekly}` | Core totals are available, but top-customer ranking, the full legacy revenue-trend series, and branch-performance breakdown are not equivalent endpoints. |
| [`inventory.ts`](</C:/Users/user/Desktop/washlab-backend-main/washlab-backend-main/convex/inventory.ts>): admin/station list, create/update/stock/order/receive/request | `/v1/admin/inventory*`, `/v1/station/inventory*` | Core operations map. Station credentials move to the header; the UI's category/status filtering remains client-side. |
| [`loyalty.ts`](</C:/Users/user/Desktop/washlab-backend-main/washlab-backend-main/convex/loyalty.ts>): balances/transactions/admin stats/top customers/adjust/redeem | `/v1/customers/loyalty*`, `/v1/admin/loyalty/*`, `/v1/station/customers/:id/loyalty`, `POST /v1/customers/orders/:id/loyalty/redeem`, `POST /v1/station/orders/:id/loyalty/redeem` | Customer- and station-authorized point redemption is now transactional, order-scoped, balance-locked, and protected against duplicate redemption. Legacy points-list and top-customer reporting remain missing. |
| [`vouchers.ts`](</C:/Users/user/Desktop/washlab-backend-main/washlab-backend-main/convex/vouchers.ts>): validate, CRUD, apply-to-order, batch operations and usages | `/v1/vouchers/validate`, `/v1/admin/vouchers*`, `/v1/station/vouchers/*` | Validation and admin management exist; order creation can include a voucher code. There is no separate `applyToOrder` endpoint. Legacy multi-branch applicability is now retained in `vouchers.applicable_branches` and enforced in validation/order queries. |
| [`subscriptions.ts`](</C:/Users/user/Desktop/washlab-backend-main/washlab-backend-main/convex/subscriptions.ts>): plans, member/guest purchases, verification/status/history, admin grants/adjust/cancel/stats/OTP outbox/promo images, station lookup/OTP state/verified orders/gift vouchers/redeem | `/v1/customer/subscriptions/{plans,buy,guest-buy,verify,me,promo-images}`, `/v1/station/subscriptions/{lookup,send-otp,redeem}`, `/v1/admin/subscriptions/{plans,active,promo-images}` | Guest purchase, Paystack verification polling, promo-image customer listing, and admin promo-image CRUD/reordering are now implemented. History, voucher, grant/adjust/cancel, OTP outbox, and reporting operations remain absent. The intended new OTP remains a single 4-digit code plus attendant PIN checks. |
| [`notifications.ts`](</C:/Users/user/Desktop/washlab-backend-main/washlab-backend-main/convex/notifications.ts>): customer/station/admin lists, unread counts, mark/delete/create | `/v1/customers/notifications*`, `/v1/station/notifications*`, `/v1/admin/notifications*` | Most list and mutation operations map. Admin unread-count has no dedicated route; clients should not infer a full count from a paginated list. |
| [`qrClockIn.ts`](</C:/Users/user/Desktop/washlab-backend-main/washlab-backend-main/convex/qrClockIn.ts>): QR token creation/status/public info and PIN clock completion | None | Missing. |
| [`branchMachines.ts`](</C:/Users/user/Desktop/washlab-backend-main/washlab-backend-main/convex/branchMachines.ts>), [`services.ts`](</C:/Users/user/Desktop/washlab-backend-main/washlab-backend-main/convex/services.ts>), [`admin.ts`](</C:/Users/user/Desktop/washlab-backend-main/washlab-backend-main/convex/admin.ts>) service images and branch services | `/v1/admin/branches/:id/machines`, `/v1/station/machines`, `/v1/admin/branches/:id/services`, `/v1/admin/images/upload`, `/v1/services*` | Machine/service CRUD and catalogs exist. When S3 is unavailable, the admin upload endpoint validates supported base64 image data and returns a data URL; durable/object-storage hosting and storage-ID resolution are not configured. |
| [`headlines.ts`](</C:/Users/user/Desktop/washlab-backend-main/washlab-backend-main/convex/headlines.ts>) | `/v1/admin/headlines*`, `/v1/station/notices` | Core create/list/delete and station notice surfaces map. |
| [`audit.ts`](</C:/Users/user/Desktop/washlab-backend-main/washlab-backend-main/convex/audit.ts>), [`actions.ts`](</C:/Users/user/Desktop/washlab-backend-main/washlab-backend-main/convex/actions.ts>), [`resources.ts`](</C:/Users/user/Desktop/washlab-backend-main/washlab-backend-main/convex/resources.ts>) | `/v1/admin/audit-logs`, `/v1/station/activity`; no matching action-statistics or resource-usage API identified | Audit/activity logs are partial. Resource usage tracking and action-by-attendance/attendant/entity statistics are missing from the new API. |
| [`clerk.ts`](</C:/Users/user/Desktop/washlab-backend-main/washlab-backend-main/convex/clerk.ts>): Clerk user create/update/delete synchronization | No Clerk webhook route was found in the rebuilt app registration | Missing or handled outside this API; confirm identity provisioning before cutover. |
| Convex [`migration.ts`](</C:/Users/user/Desktop/washlab-backend-main/washlab-backend-main/convex/migration.ts>) (`exportTable`, `importRow`) | [`scripts/import-convex.ts`](./scripts/import-convex.ts) | Replaced by a batched, idempotent JSONL-to-Postgres importer; it does not call Convex at runtime. |
| [`drivers.ts`](</C:/Users/user/Desktop/washlab-backend-main/washlab-backend-main/convex/drivers.ts>), [`maintenanceTickets.ts`](</C:/Users/user/Desktop/washlab-backend-main/washlab-backend-main/convex/maintenanceTickets.ts>) | Not evaluated | Explicitly excluded as requested. |

### Architecture and operational findings

- **Authentication contract:** admin/customer requests use Clerk bearer authentication. Station requests use `x-station-token`; the old UI sends `stationToken` as a Convex argument. The login branch lookup is public and rate-limited; station operational routes authenticate the header token. Guest online order creation and public order tracking are intentionally public/optional-auth. Paystack events enter through `/v1/payments/webhooks/paystack`.
- **Identity transition:** the rebuilt station model is a branch/device session with attendant PIN checks for sensitive actions. It is not a replacement for the legacy attendant's own biometric/PIN/password session. Do not cut over the legacy biometric or QR-clock workflows without a product decision or new routes.
- **Money representation:** the new database stores monetary values in Pesewas (`bigint`). [`src/app.ts`](./src/app.ts) serializes safe BigInts as JSON numbers and larger values as decimal strings; consumers should accept both.
- **Load/token math:** [`station/pricing.ts`](./src/modules/station/pricing.ts) centralizes load calculations as `ceil(weightKg / 8)`, prices per load in Pesewas, and only permits extra wash/dry loads for compatible service types. Walk-in `wash_and_dry` intentionally charges its wash and dry units separately, matching the legacy flow distinction.
- **Lists vs. totals:** paginated REST list handlers use bounded `limit`/`offset` or keyset pagination and SQL count queries; analytics/stat endpoints are separate aggregates. Do not calculate dashboard totals by summing a page of list results. The legacy customer/admin pages still make some large first-page requests and may require paging/export behavior changes.
- **Paystack dropped/late-event handling:** payments are stored before charge initiation; settlement finds current and prior attempt references, verifies server-side, locks order/payment rows, and is idempotent. A UI must not treat popup dismissal as proof of payment. Reconciliation similarly uses a persisted transaction/reference plus explicit OTP and verification routes.
- **Current migration-only schema changes:** [`0017_soft_forge.sql`](./db/migrations/0017_soft_forge.sql) adds the missing `legacy_convex_id` columns needed by cash/loyalty/voucher imports, preserves loyalty descriptions, and adds multi-branch voucher scope. Run migrations before importing.

## 2. Frontend parity audit

Status definitions: **Mapped** = equivalent REST operation exists; **Needs Payload Change** = endpoint exists but body/query/auth/flow must change; **Missing** = no equivalent route; **Excluded** = intentionally outside scope. Rows group calls by UI surface, but every discovered Convex function name is listed. Calls described as unused are source-level bindings, not observed runtime requests. No Convex feature-flag gates were found in the three repositories.

### Attendant app

Repository: [`washlab-attendant-main`](</C:/Users/user/Desktop/washlab-attendant-main/washlab-attendant-main>)

| Button / hook / surface | Old Convex call(s) | New REST endpoint | Status / notes |
|---|---|---|---|
| Station login ([login page](</C:/Users/user/Desktop/washlab-attendant-main/washlab-attendant-main/app/(auth)/login/page.tsx>)) | `admin.getBranchByCode`, `stations.loginStation` | `GET /v1/station/branches/by-code/:code`, `POST /v1/station/login` | Needs Payload Change: normalize body and retain device fields; the resulting station token is sent in `x-station-token`. |
| Enrollment-token route | `attendants.verifyEnrollmentToken` | None | Missing. |
| Attendant login flow ([LoginFlow](</C:/Users/user/Desktop/washlab-attendant-main/washlab-attendant-main/components/auth/LoginFlow.tsx>)) | `attendants.findByEmail`, `authenticateWithPinOrPassword`, `startVerification`, `verifyBiometric`, `createSession` | Station login and `/v1/station/verify-pin` | Missing for per-attendant auth, biometric challenge, and individual session. The branch/device station login is not semantically equivalent. |
| Enrollment flow ([EnrollmentFlow](</C:/Users/user/Desktop/washlab-attendant-main/washlab-attendant-main/components/auth/EnrollmentFlow.tsx>)) | `attendants.startBiometricEnrollment`, `completeBiometricEnrollment`, `completePINSetup` | Admin enrollment routes only | Needs Payload Change for admin invitation; biometric enrollment has no endpoint. |
| Session hook and guard | `stations.verifyStationSession` | `GET /v1/station/session` | Needs Payload Change: header token instead of query/body argument. Hook and guard both query independently. |
| Active attendance hooks/layout/order detail/reports/action dialog | `stations.getActiveStationAttendances` | `GET /v1/station/attendance/active` | Needs Payload Change: header token and new pagination parameters. |
| Clock-in/out selector | `stations.getBranchAttendants`, `dailyReports.getDraft` | `GET /v1/station/attendants`, `GET /v1/station/reports/draft` | Needs Payload Change: REST query names and header auth. |
| Biometric clock hooks | `stations.startClockInVerification`, `completeClockIn`, `startClockOutVerification`, `completeClockOut` | None | Missing; hook bindings are not used by the visible clock buttons. |
| PIN clock buttons | `stations.completeClockInWithPIN`, `completeClockOutWithPIN` | `POST /v1/station/attendance/clock-in`, `/clock-out` | Needs Payload Change: REST body and station header contract. |
| Critical-action PIN dialog | `attendants.verifyAttendantPIN` | `POST /v1/station/verify-pin` | Needs Payload Change. |
| Identity-verification hook (no caller found) | `attendants.startVerification`, `attendants.verifyBiometric` | None | Missing; hook is not surfaced in this repository. |
| Dashboard/stats/services | `stations.getStationStats`, `branches.getById`, `admin.getBranchServices` | `GET /v1/station/stats`, `/v1/branches/:id`, `/v1/station/services` | Needs Payload Change. |
| Order list/detail hooks | `stations.getStationOrders`, `stations.getStationOrderDetails` | `GET /v1/station/orders`, `GET /v1/station/orders/:id` | Needs Payload Change: cursor to REST pagination and token to header. |
| Online-order screen | `stations.getStationOrders`, `getActiveBagNumbers`, `getStationInfo`, `admin.getBranchServices`, `branchMachines.getActiveMachines`, `checkInOnlineOrder`, `cancelOnlineOrder` | `/v1/station/orders`, `/orders/bag-numbers`, `/info`, `/services`, `/machines`, `/orders/:id/check-in`, `/orders/:id/cancel` | Needs Payload Change for auth/body. `checkInOnlineOrder` was bound but no invocation was found. |
| Customer cards/search | `stations.getStationOrders`, `loyalty.getPointsForAttendant`, `stations.searchStationCustomers` | `/v1/station/orders`, `/customers/:id/loyalty`, `/customers/search` | Needs Payload Change: query and header contract. |
| Walk-in order form | `admin.getServiceImageUrl`, `admin.getBranchServices`, `branchMachines.getActiveMachines`, `customers.getByPhone`, `stations.getActiveBagNumbers`, `customers.createGuest`, `stations.createWalkInOrder` | `GET /v1/station/services`, `/machines`, `/orders/bag-numbers`; `/customers/search`; `POST /v1/station/customers`, `/orders/walk-in` | Needs Payload Change. Service image URL resolution is Missing. |
| Order status/edit/payment recovery | `stations.updateStationOrderStatus`, `stations.updateOrderDetails`, `paymentsRecovery.verifyAndRecoverPayment` | `PATCH /v1/station/orders/:id/status`, `PATCH /orders/:id`, payment finalize route | Needs Payload Change; recovery semantics are not one-for-one. |
| Attendance/activity/transaction/settings pages | `stations.getStationAttendanceHistory`, `getStationActivityLogs`, `getStationTransactions`, `getStationInfo` | `/v1/station/attendance/history`, `/activity`, `/transactions`, `/info` | Needs Payload Change: query fields, pagination, and header auth. |
| Station inventory page and request dialog | `inventory.getStationInventory`, `inventory.requestOrder` | `GET /v1/station/inventory`, `POST /v1/station/inventory/:id/request-order` | Needs Payload Change. |
| Inventory helper hooks (no callers found) | `inventory.updateStock`, `placeOrder`, `receiveOrder`, `create` | `/v1/station/inventory/:id/stock`, `/order`, `/receive`, `/inventory` | Needs Payload Change; helpers are not currently surfaced. |
| Payment page | `payments.create`, `initiate`, `finalizePaymentSafe`, `saveGatewayReference`, `resetToPending`, `paymentsRecovery.verifyAndRecoverPayment`, `vouchers.applyToOrder`, `loyalty.redeemPointsForAttendant` | `/v1/station/orders/:id/payment`, `/payment/finalize`, `/v1/station/vouchers/validate`, `/v1/vouchers/validate`, `/v1/station/orders/:id/loyalty/redeem` | Needs Payload Change for payment lifecycle; station loyalty redemption now has a dedicated endpoint. Separate voucher application/recovery behavior still needs adaptation. |
| Payment-page supporting queries | `vouchers.getActive`, `loyalty.getPointsForAttendant`, `paymentsRecovery.getPaymentStatusForOrder`, `vouchers.validate` | `/v1/station/vouchers/active`, `/customers/:id/loyalty`, `/v1/station/orders/:id`, `/v1/station/vouchers/validate` | Needs Payload Change; no distinct payment-status-by-order route. |
| Subscription search/verification/redemption | `subscriptions.stationLookup`, `stationGiftVoucherLookup`, `stationGetOtpState`, `stationOrdersForVerified`, `stationRequestOtp`, `stationVerifyOtp`, `stationRedeem`, `stationFindForOrder` | `/v1/station/subscriptions/lookup`, `/send-otp`, `/redeem` | **Needs Payload Change / Missing.** New implementation has 4-digit send-and-redeem flow with PIN checks; frontend expects 6-digit OTP state/verification, verified-order retrieval, gift-voucher lookup, and order lookup. |
| Header/notifications | `stations.getStationUnreadCount`, `logoutStation`, `getStationNotifications`, `markStationNotificationAsRead`, `markAllStationNotificationsAsRead` | `/v1/station/notifications/unread-count`, `/logout`, `/notifications`, `/notifications/:id/read`, `/notifications/read-all` | Needs Payload Change. |
| Reconciliation/outstanding pages | `cashReconciliation.getTodayCashSummary`, `getTodayCashOrders`, `getTodayCashDeductions`, `getReconciliationHistory`, `initiateCashReconciliation`, `submitOtp`, `verifyAndComplete`, `saveReconciliation`, `saveCashDeduction`, `paymentsRecovery.verifyAndRecoverRecon` | `/v1/station/cash/summary`, `/orders`, `/deductions`, `/history`, `/reconciliations`, `/reconciliations/:reference/otp`, `/verify` | Needs Payload Change: old action/reference shapes differ; reconcile UI must adopt the REST transaction reference lifecycle. |
| Daily report page and ReportsContent | `dailyReports.getAutoData`, `getDraft`, `getByBranch`, `saveDraft`, `submit`; `stations.getActiveStationAttendances`; `branchMachines.getActiveMachines` | `/v1/station/reports/auto`, `/draft`, `/submit`; `/v1/station/attendance/active`, `/machines`; no report-list endpoint | Needs Payload Change for auto/draft/save/submit; `dailyReports.getByBranch` is Missing. |
| QR clock-in modal/page | `qrClockIn.generateQRToken`, `getQRTokenStatus`, `getQRTokenInfo`, `completeQRClockIn` | None | Missing. |
| Maintenance-specific bindings | `maintenanceTickets.reportFault` | Excluded | Explicitly excluded; not evaluated. |

### Admin app

Repository: [`washlab-admin-dev`](</C:/Users/user/Desktop/washlab-admin-dev/washlab-admin-dev>)

| Button / hook / surface | Old Convex call(s) | New REST endpoint | Status / notes |
|---|---|---|---|
| Current-admin hook | `admin.getCurrentUser` | `GET /v1/admin/me` | Mapped. |
| Dashboard/sidebar unread badge | `notifications.getUnreadCount` | None dedicated | Missing. A paginated notification list is not a safe replacement for a total count. |
| Attendance page | `admin.getBranches`, `admin.getAttendanceLogs` | `GET /v1/admin/branches`, `/v1/admin/attendance/logs` | Needs Payload Change for branch list and query shape; filtered attendance-log list is available. |
| Station attendance summary | `admin.getBranchAttendanceSummary` | `GET /v1/admin/branches/attendance-summary` | Mapped, subject to query/payload shape. |
| Staff/enrollment/actions | `admin.listAttendantEnrollments`, `createAttendantEnrollment`, `resendEnrollmentLink`, `updateAttendantBranchAccess`, `suspendAttendant`, `activateAttendant`, `lockAttendant`, `resetAttendantFailures`, `revokeAttendantSessions`, `deleteAttendant`, `sendAttendantPasswordReset`; unused binding `updateAttendant` | `/v1/admin/staff`, `/staff/enroll`, `/staff/:id/resend-enrollment`, `PUT /staff/:id/branches`, staff activate/suspend/lock/unlock/reset/revoke/delete routes | Most are Needs Payload Change; password-reset endpoint is Missing. `updateAttendant` is bound but no call was found; REST staff patch exists. |
| Admin settings | `admin.getCurrentUser`, `getSystemSettings`, `updateAdminProfile`, `updateSystemSettings`, `updateReportEmailPreference` | `GET/PATCH /v1/admin/settings`, `GET /v1/admin/me` | Settings read/update are Mapped with payload changes; admin-profile update and report-email preference are Missing as distinct operations. |
| Dashboard | `admin.getOrders`, `admin.getBranches`, `admin.getPaymentStats`, `admin.getAnalytics`, `admin.getWeeklyOrderStats` | `/v1/admin/orders`, `/branches`, `/analytics/payments`, `/analytics/overview`, `/analytics/weekly` | Mapped; adapt date/filter parameters and list pagination. Stats must remain unpaginated aggregates. |
| Orders page/detail | `admin.getBranches`, `admin.getOrders`, `admin.getOrderDetails` | `/v1/admin/branches`, `/admin/orders`, `/admin/orders/:id` | Mapped; Convex cursor/large page sizes must become bounded REST pagination. |
| Payments page | `payments.getTransactionHistory`, `payments.getTransactionSummary` | `/v1/admin/payments/transactions`, `/v1/admin/analytics/payments` | Transaction history is now paginated/filterable; summary is mapped with payload adaptation. |
| Reports and report detail | `admin.getWeeklyOrderStats`, `analytics.getRevenueTrends`, `admin.getBranches`, `admin.getOrders`, `dailyReports.getAll`, `getById`, `getOutstandingOrders`, `getAutoData` | `/v1/admin/analytics/weekly`, `/analytics/overview`, `/admin/orders`, `/admin/reports`, `/admin/reports/:id` | Needs Payload Change; trends, outstanding-order detail, and admin auto-data parity are incomplete. |
| Audit logs | `audit.getAll` | `GET /v1/admin/audit-logs` | Needs Payload Change: filter and pagination names. |
| Notifications | `notifications.getAllNotifications`, `getUnreadCount`, `createNotification`, `markAsRead`, `markAllAsRead`, `adminDeleteNotification` | `/v1/admin/notifications`, `/notifications/:id`, `/notifications/mark-all-read` | List and mutations are Mapped with payload changes; unread-count endpoint is Missing. |
| Customers / export | `admin.getCustomerStats`, `branches.getActive`, `loyalty.getAllLoyaltyPoints`, `admin.getAllCustomersForExport`, `admin.getCustomers`, `loyalty.getTopLoyaltyCustomers`, `admin.changeCustomerStatus`, `admin.deleteCustomer` | `/v1/admin/customers/stats`, `/branches/active`, `/admin/customers`, `/admin/customers/export.csv`, `/customers/:id/status`, `/customers/:id` | Customer list/stats/status/delete map. Filtered CSV export is now available; all-customer loyalty points and top-loyalty-customer list remain missing. |
| Loyalty points/transactions | `loyalty.getLoyaltyStats`, `getAllLoyaltyPoints`, `getAllTransactions`, `adjustPoints` | `/v1/admin/loyalty/stats`, `/transactions`, `/adjust` | Stats/transactions/adjust are Mapped; points list is Missing. |
| Inventory | `admin.getBranches`, `inventory.getByBranch`, `inventory.create`, `inventory.update`, `inventory.deleteItem` | `/v1/admin/branches`, `/admin/inventory` CRUD | Mapped with REST pagination and payload changes. |
| Branches/services/machines | `admin.getServiceImageUrl`, `admin.getBranchServices`, `branchMachines.listByBranch`, `admin.getCurrentUser`, service create/update/delete/upload, machine create/update/remove, branch create/update/toggle/delete | `/v1/admin/branches*`, `/branches/:id/services`, `/branch-services/:id`, `/branches/:id/machines`, `/machines/:id`, `/images/upload` | Main CRUD is Mapped. Base64 image data URL upload is available; persistent storage-backed resolution remains unavailable. |
| Headlines | `branches.getActive`, `headlines.getAll`, `headlines.create`, `headlines.remove` | `/v1/branches/active`, `/v1/admin/headlines` CRUD | Mapped with payload changes. |
| Reconciliation | `cashReconciliation.getBranchCashSummariesForAdmin`, `getAllReconciliationsForAdmin`, `getAllDeductionsForAdmin` | `/v1/admin/reconciliation/summaries`, `/history`, `/deductions` | Mapped with filters/pagination changes. |
| Subscription management/overview | `subscriptions.adminListPlans`, `createPlan`, `updatePlan`, `deletePlan`, `adminListSubscriptions`, `adminGetSubscription`, `adminStats`, `adminAdjustLoads`, `adminCancel`, `adminGrant`, `adminOtpOutbox`, `adminMarkOtpDelivered`, `adminListPromoImages`, `adminAddPromoImage`, `adminReorderPromoImages`, `adminUpdatePromoImage`, `adminDeletePromoImage`; `vouchers.adminBatches`, `createBatch`, `adminDeactivateBatch`, `adminBatchVouchers` | `/v1/admin/subscriptions/plans`, `/subscriptions/active`, `/subscriptions/promo-images`; `/v1/admin/vouchers/batches*` | Plan list/create/update/deactivate, active list, and promo-image list/create/reorder/update/delete map. Detailed subscription operations, OTP outbox, and full stats/filter parity are Missing. Voucher batch management is partial; adapt payloads. |
| Vouchers page | `vouchers.getAll`, `branches.getActive`, `vouchers.create`, `vouchers.update` | `/v1/admin/vouchers` CRUD | Mapped with payload changes; multi-branch scope is preserved by the new schema migration. |
| Maintenance screen | `maintenanceTickets.listTickets`, `markFixed`, `deleteTicket`, `reportFault` | Excluded | Explicitly excluded; not evaluated. |

### Customer app

Repository: [`washlab-customer-main`](</C:/Users/user/Desktop/washlab-customer-main/washlab-customer-main>)

| Button / hook / surface | Old Convex call(s) | New REST endpoint | Status / notes |
|---|---|---|---|
| Current-customer hook | `customers.getProfile`, `customers.checkIsAdminOrAttendant` | `GET /v1/customers/profile`, `/check-role` | Mapped; bearer-auth header replaces Convex auth. |
| Sign-up / complete profile / profile edit | `customers.updateProfile`, `customers.register`, `branches.getActive` | `PATCH/POST /v1/customers/profile`, `/register`, `GET /v1/branches/active` | Mapped; reconcile profile field names and clearing optional values. |
| Public order form/pricing | `branches.getActive`, `admin.getBranchServicesForCustomer`, `admin.getServiceImageUrl` | `GET /v1/branches/active`, `/v1/services/branch/:branchId` | Branch/services are Mapped; storage-ID image resolution is Missing. |
| Customer checkout | `customers.getProfile`, `vouchers.validate`, `orders.createOnline`, `vouchers.applyToOrder`, `loyalty.redeemPoints` | `GET /v1/customers/profile`, `/v1/vouchers/validate`, `POST /v1/orders/online`, `POST /v1/customers/orders/:id/loyalty/redeem` | Needs Payload Change: voucher code belongs in order creation rather than a separate apply mutation. Customer loyalty redemption now has a dedicated order-scoped endpoint. |
| Tracking | `customers.getActiveOrders`, `orders.getByOrderNumber` | `GET /v1/customers/orders/active`, `/v1/orders/track/:orderNumber` | Mapped; pagination and route parameter differ. |
| Dashboard | `customers.getProfile`, `getLoyaltyPoints`, paginated `getOrders`, `notifications.getUnreadCount` | `/v1/customers/profile`, `/loyalty`, `/orders`, `/notifications/unread-count` | Mapped; use REST `limit`/`offset` and total-count headers. |
| Orders/payment history | `services.getActive`, paginated `customers.getOrders`, `payments.getByCustomer` | `GET /v1/services`, `/v1/customers/orders`, `/v1/customers/payments` | Mapped with REST pagination. |
| Notifications | `notifications.getMyNotifications`, `getUnreadCount`, `markAsRead`, `markAllAsRead`, `deleteNotification` | `/v1/customers/notifications*` | Mapped; mutation verb/path and pagination payload change. |
| Loyalty page | `loyalty.getBalance`, paginated `loyalty.getTransactions` | `GET /v1/customers/loyalty`, `/loyalty/transactions` | Mapped. |
| Subscription dashboard/history | `subscriptions.getMySubscriptions`, `getMyPendingOtps`, `getMySubscriptionHistory` | `GET /v1/customer/subscriptions/me` | Active/current list is partial; pending OTP and full history are Missing. |
| Subscription plan purchase | `subscriptions.listAvailablePlans`, `getPurchaseStatus`, `initiatePurchase`, `guestInitiatePurchase`, `verifyPurchase`, `verifyGuestPurchase`, `branches.getActive`, `customers.getProfile` | `GET /v1/customer/subscriptions/plans`, `POST /v1/customer/subscriptions/buy`, `POST /v1/customer/subscriptions/guest-buy`, `POST /v1/customer/subscriptions/verify` | Member purchase needs payload adaptation. Guest purchase and explicit Paystack verification polling are now available. |
| Subscription promo content | `subscriptions.getPromoImages`, `subscriptions.getFlyer` | `GET /v1/customer/subscriptions/promo-images` | Promo-image listing is available; `getFlyer` remains missing and was referenced by an apparently unused root-level component. |
| Skipped loyalty query | `loyalty.getBalance` with always-`skip` arguments in public order form | No request is sent | Not an active call site; no migration required for this reference. |

## 3. Cutover checklist and import runbook

### Before cutover

- [ ] Decide whether biometric attendant login, QR clock-in, subscription history/OTP state, and remaining admin reporting/analytics gaps must be available on day one. Loyalty redemption, guest subscription purchase/verification, promo images, filtered attendance/transaction history, CSV export, and base64 image upload are now available.
- [ ] Update frontend clients to use REST routes, bearer auth or `x-station-token`, UUID path identifiers, the documented request schemas, and `limit`/`offset`. Do not send station tokens in request bodies.
- [ ] Deploy the backend schema migrations before importing. In particular, apply `0017_soft_forge.sql` and the generated `0018_lazy_mac_gargan.sql`.
- [ ] Validate Paystack webhook URL/signature configuration and exercise a test purchase plus webhook settlement before directing live traffic.
- [ ] Confirm backup/restore and rollback procedures for both databases; run the importer first with `--dry-run`.
- [ ] Compare source/target row totals and representative financial totals after the import. Reconcile Pesewas totals before opening writes on the new system.
- [ ] Switch one station/customer/admin cohort at a time, monitor API errors and payment/reconciliation queues, then disable legacy writes only after parity checks pass.

### Importer contract

[`scripts/import-convex.ts`](./scripts/import-convex.ts) reads one JSON Lines file per Convex table. Each line is a raw exported document containing its Convex `_id` and source fields. It streams each file, retains only ID maps and relationship IDs, and batches inserts in chunks of 500.

Required files:

```text
admins.jsonl
branches.jsonl
branchServices.jsonl
branchMachines.jsonl
services.jsonl
attendants.jsonl
users.jsonl
subscriptionPlans.jsonl
customerSubscriptions.jsonl
orders.jsonl
subscriptionUsages.jsonl
payments.jsonl
branchCashLedger.jsonl
cashDeductions.jsonl
cashReconciliations.jsonl
branchCashCredits.jsonl
loyaltyPoints.jsonl
loyaltyTransactions.jsonl
vouchers.jsonl
voucherUsages.jsonl
```

The script imports `admins` first as a prerequisite because subscription plans have a required `created_by_admin_id` foreign key. It then imports branches and supporting global/branch services and machines, followed by the requested Attendants → Customers → Subscription Plans → Customer Subscriptions → Orders → Payments → Cash Ledger → Loyalty/Vouchers sequence. Subscription usages are imported after their orders. Branch machines are imported before orders because orders can reference them.

Example:

```powershell
Set-Location C:\Users\user\Desktop\Washlab-Backend-new-main\Washlab-Backend-new-main
npm run db:migrate
npm exec tsx -- scripts/import-convex.ts --input-dir C:\path\to\convex-jsonl --dry-run
npm exec tsx -- scripts/import-convex.ts --input-dir C:\path\to\convex-jsonl
```

The script needs a valid `DATABASE_URL`. `--dry-run` reads the target for existing IDs and logs per-stage planned inserts/skips without writing. Re-runs skip rows by `legacy_convex_id`; conflicting non-legacy unique values fail instead of being silently ignored.

### Data conversion and known limitations

- GHS numeric source amounts are rounded to Pesewas (`GHS * 100`) and stored as `bigint`. The API serializes safe values as numbers and larger values as decimal strings.
- Convex numeric timestamps are preserved as timestamps; legacy PIN values are converted from `hash:salt` or `passcodeHash` + `passcodeSalt` to `legacy-sha256$salt$hash`. The importer fails if it cannot preserve a verifiable PIN.
- Legacy multi-branch voucher restrictions are retained in `applicable_branches`; a voucher without a branch restriction remains global. The importer does not widen a restricted voucher to all branches.
- Convex `imageStorageId` references cannot be resolved by the importer; explicit source `imageUrl` strings are copied, but storage-backed service images need separate asset migration.
- Orders without a resolvable customer are associated with an existing customer by phone or a synthetic `legacy-guest:<phone>` customer. Source rows that lack both a usable customer ID and phone fail with a file/line diagnostic.
- `cash_ledger.outstanding` is database-generated from imported collected/sent/deducted/credit values; it is not copied independently. Legacy cash reconciliations without a Paystack reference receive a `LEGACY-CASH-<Convex ID>` reference.
- The new branch table has no country, delivery-option flags, or branch creator field; branch country/delivery options are not preserved by this script. The customer loyalty snapshot transfers current points only, not cumulative earned/redeemed totals; voucher usage rows do not retain legacy before/after totals or the attendant who applied them. The target model also cannot preserve all legacy admin preferences, biometric templates/sessions, order status history, notifications, daily reports, resource/action logs, promo images, or every payment gateway response. Those are outside the requested import sequence and require a separate migration/schema decision if they are needed.
- Legacy reconciliations and per-day cash aggregates are imported, but `cash_recon_allocations` cannot be reconstructed exactly from the legacy records; the importer preserves aggregate ledger totals and transaction history, not every old send-to-day allocation edge.
- `drivers`, `maintenanceTickets`, and their related records are intentionally not imported.

## 4. Changes made for this handover

- Added [`scripts/import-convex.ts`](./scripts/import-convex.ts) with streamed JSONL ingestion, 500-row batches, legacy-ID idempotency, dry-run reporting, Pesewas/timestamp/PIN conversion, foreign-key remapping, and explicit fail-fast diagnostics.
- Added the importer-support Drizzle migration [`db/migrations/0017_soft_forge.sql`](./db/migrations/0017_soft_forge.sql).
- Added `legacy_convex_id` to cash ledger/credits and loyalty/voucher records that lacked it.
- Preserved legacy multi-branch voucher scope in the target schema and applied that scope in customer/station voucher checks and admin listing.
- Preserved source loyalty transaction descriptions in the target ledger.
- No frontend repository was modified.

## Validation

- `npm run typecheck` — passed.
- `npx drizzle-kit generate` — passed and generated `0017_soft_forge.sql`.
- `npm exec tsx -- scripts/import-convex.ts --help` — passed.
- `npm test -- src/modules/station/discounts.test.ts` — attempted; setup failed because Postgres at `localhost:5433` refused connections, so no database-backed assertions ran.
- Import/dry-run was not executed because no source JSONL export or reachable Postgres service was available.
