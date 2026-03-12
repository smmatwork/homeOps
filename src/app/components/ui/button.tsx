import { Button as MuiButton, ButtonProps as MuiButtonProps } from "@mui/material";

interface ButtonProps extends MuiButtonProps {
  variant?: "contained" | "outlined" | "text";
}

export function Button({ variant = "contained", ...props }: ButtonProps) {
  return <MuiButton variant={variant} {...props} />;
}
