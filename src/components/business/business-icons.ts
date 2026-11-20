import type { ComponentType } from 'react';
import { Pill, Shirt, ShoppingBasket, ShoppingCart, Smartphone, UtensilsCrossed, Warehouse, Wrench } from 'lucide-react';
import type { BusinessType } from '@/lib/business-profile';

/** Icon for each business type (Business profile screen and setup wizard). */
export const typeIcon: Record<BusinessType, ComponentType<{ className?: string | undefined }>> = {
  grocery: ShoppingBasket,
  supermarket: ShoppingCart,
  pharmacy: Pill,
  electronics: Smartphone,
  garments: Shirt,
  hardware: Wrench,
  wholesale: Warehouse,
  restaurant: UtensilsCrossed,
};
