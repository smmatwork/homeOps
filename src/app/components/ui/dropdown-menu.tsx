"use client";

import * as React from "react";
import {
  Menu,
  MenuItem,
  MenuList,
  MenuProps,
  MenuItemProps,
  Divider,
  Typography,
  Box,
  IconButton,
} from "@mui/material";
import { MoreVert as MoreVertIcon } from "@mui/icons-material";

interface DropdownMenuProps extends MenuProps {
  trigger: React.ReactNode;
  items: Array<{
    label: string;
    onClick: () => void;
    icon?: React.ReactNode;
    divider?: boolean;
  }>;
}

export function DropdownMenu({ trigger, items, ...props }: DropdownMenuProps) {
  const [anchorEl, setAnchorEl] = React.useState<null | HTMLElement>(null);

  const handleOpen = (event: React.MouseEvent<HTMLElement>) => {
    setAnchorEl(event.currentTarget);
  };

  const handleClose = () => {
    setAnchorEl(null);
  };

  return (
    <Box>
      <Box onClick={handleOpen} sx={{ display: "inline-block" }}>
        {trigger}
      </Box>
      <Menu
        anchorEl={anchorEl}
        open={Boolean(anchorEl)}
        onClose={handleClose}
        {...Object.fromEntries(Object.entries(props).filter(([key]) => key !== "open"))}
      >
        <MenuList>
          {items.map((item, index) => (
            <React.Fragment key={index}>
              <MenuItem
                onClick={() => {
                  item.onClick();
                  handleClose();
                }}
              >
                {item.icon && <Box sx={{ mr: 1 }}>{item.icon}</Box>}
                <Typography variant="body2">{item.label}</Typography>
              </MenuItem>
              {item.divider && <Divider />}
            </React.Fragment>
          ))}
        </MenuList>
      </Menu>
    </Box>
  );
}
