export type Role = "super_admin" | "admin" | "attendant" | "driver" | "customer";

export const PERMISSIONS = [
    "branch.read",
    "branch.create",
    "branch.update",
    "branch.delete",
    "order.read",
    "order.create",
    "order.update_status",
    "order.delete",
    "customer.read",
    "customer.delete",
    "attendant.manage",
    "inventory.manage",
    "report.view",
    "pricing.update",
    "settings.update",
    "admin.manage",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

// Destructive actions, pricing, settings and admin management are super_admin only.
const rolePermissions: Record<Role, readonly Permission[] | "*"> = {
    super_admin: "*",
    admin: [
        "branch.read",
        "branch.update",
        "order.read",
        "order.create",
        "order.update_status",
        "customer.read",
        "attendant.manage",
        "inventory.manage",
        "report.view",
    ],
    attendant: ["branch.read", "order.read", "order.create", "order.update_status", "customer.read"],
    driver: ["order.read"],
    customer: ["order.create"],
};

export function can(role: Role, permission: Permission): boolean {
    const granted = rolePermissions[role];
    return granted === "*" || granted.includes(permission);
}