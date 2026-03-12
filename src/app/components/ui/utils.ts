import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Utility function to merge class names.
 * This is useful for combining Tailwind CSS classes dynamically.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Utility function to convert a class name string into a Material-UI `sx` object.
 * This can be used to integrate Tailwind CSS classes with Material-UI's `sx` prop.
 */
export function classToSx(className: string) {
  return { className };
}
