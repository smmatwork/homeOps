import * as React from "react";
import { Card as MuiCard, CardContent as MuiCardContent, CardHeader as MuiCardHeader, CardProps } from "@mui/material";

import { cn } from "./utils";

export function Card(props: CardProps) {
  return <MuiCard {...props} />;
}

export function CardHeader(props: CardProps) {
  return <MuiCardHeader {...props} />;
}

export function CardContent(props: CardProps) {
  return <MuiCardContent {...props} />;
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <h4
      data-slot="card-title"
      className={cn("leading-none", className)}
      {...props}
    />
  );
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <p
      data-slot="card-description"
      className={cn("text-muted-foreground", className)}
      {...props}
    />
  );
}

function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={cn(
        "col-start-2 row-span-2 row-start-1 self-start justify-self-end",
        className,
      )}
      {...props}
    />
  );
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn("flex items-center px-6 pb-6 [.border-t]:pt-6", className)}
      {...props}
    />
  );
}

export {
  CardFooter,
  CardTitle,
  CardAction,
  CardDescription,
  CardContent,
};
