import { cva, type VariantProps } from "class-variance-authority";
import { Button as MuiButton, ButtonProps as MuiButtonProps } from "@mui/material";
import { cn } from "./utils";

export const buttonVariants = cva("", {
  variants: {
    variant: {
      default: "",
      contained: "",
      outline: "",
      ghost: "",
    },
    size: {
      default: "",
      sm: "",
      lg: "",
      icon: "",
    },
  },
  defaultVariants: {
    variant: "default",
    size: "default",
  },
});

type ShadcnVariant = NonNullable<VariantProps<typeof buttonVariants>["variant"]>;
type ShadcnSize = NonNullable<VariantProps<typeof buttonVariants>["size"]>;

type ButtonProps = Omit<MuiButtonProps, "variant" | "size"> &
  VariantProps<typeof buttonVariants> & {
    variant?: ShadcnVariant;
    size?: ShadcnSize;
  };

function toMuiVariant(variant: ShadcnVariant | null | undefined): NonNullable<MuiButtonProps["variant"]> {
  if (variant === "contained") return "contained";
  if (variant === "outline") return "outlined";
  return "text";
}

function toMuiSize(size: ShadcnSize | null | undefined): NonNullable<MuiButtonProps["size"]> {
  if (size === "sm") return "small";
  if (size === "lg") return "large";
  if (size === "icon") return "small";
  return "medium";
}

export function Button({ variant = "default", size = "default", className, ...props }: ButtonProps) {
  return (
    <MuiButton
      variant={toMuiVariant(variant)}
      size={toMuiSize(size)}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}
