import { asc, eq } from "drizzle-orm";
import { db } from "../../platform/db/index.js";
import { subscriptionPromoImages } from "../../platform/db/schema/subscription-promo-images.js";
import { NotFoundError } from "../../platform/errors/index.js";

export const subscriptionPromoImagesService = {
  async listActive() {
    return db
      .select()
      .from(subscriptionPromoImages)
      .where(eq(subscriptionPromoImages.isActive, true))
      .orderBy(asc(subscriptionPromoImages.sortOrder), asc(subscriptionPromoImages.createdAt));
  },

  async listAll() {
    return db
      .select()
      .from(subscriptionPromoImages)
      .orderBy(asc(subscriptionPromoImages.sortOrder), asc(subscriptionPromoImages.createdAt));
  },

  async create(input: { title: string; imageUrl: string; sortOrder?: number; isActive?: boolean }) {
    const [image] = await db
      .insert(subscriptionPromoImages)
      .values({
        title: input.title,
        imageUrl: input.imageUrl,
        sortOrder: input.sortOrder ?? 0,
        isActive: input.isActive ?? true,
      })
      .returning();
    return image!;
  },

  async update(id: string, input: { title?: string; imageUrl?: string; sortOrder?: number; isActive?: boolean }) {
    const [image] = await db
      .update(subscriptionPromoImages)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(subscriptionPromoImages.id, id))
      .returning();
    if (!image) throw new NotFoundError("Subscription promo image not found", "PROMO_IMAGE_NOT_FOUND");
    return image;
  },

  async reorder(ids: string[]) {
    await db.transaction(async (tx) => {
      for (const [sortOrder, id] of ids.entries()) {
        await tx
          .update(subscriptionPromoImages)
          .set({ sortOrder, updatedAt: new Date() })
          .where(eq(subscriptionPromoImages.id, id));
      }
    });
    return { success: true };
  },

  async remove(id: string) {
    const deleted = await db
      .delete(subscriptionPromoImages)
      .where(eq(subscriptionPromoImages.id, id))
      .returning({ id: subscriptionPromoImages.id });
    if (deleted.length === 0) throw new NotFoundError("Subscription promo image not found", "PROMO_IMAGE_NOT_FOUND");
    return { success: true };
  },
};
