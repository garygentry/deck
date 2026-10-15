import { useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Button,
  CommandPalette,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  PageHeader,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ScrollArea,
  Section,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/ui";

const FRUITS = ["Apple", "Banana", "Cherry", "Damson", "Elderberry", "Fig", "Grape", "Huckleberry", "Kiwi", "Lemon", "Mango", "Nectarine"];
const LINES = Array.from({ length: 40 }, (_, index) => `Scrolled line ${index + 1}`);

/**
 * Every overlay the UI library has, each behind one trigger, on a page taller than the window
 * (so a modal's scroll lock shows). The Content-Security-Policy E2E opens each one under the
 * shell's policy: they inject `<style>` elements (the scroll lock, the scrollbar rules) that
 * must carry the page's style nonce, and position themselves through the CSSOM. A development
 * page, also built into a test build that sets `VITE_DECK_OVERLAY_LAB=true`; never shipped.
 */
export function OverlayLab() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [picked, setPicked] = useState("nothing");
  return (
    <div data-slot="overlay-lab" className="flex flex-col gap-6 p-4 md:p-6">
      <PageHeader title="Overlay lab" description="Every overlay, one trigger each." />
      <Section title="Overlays">
        <div className="flex flex-wrap items-start gap-3">
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="outline">Open dialog</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Lab dialog</DialogTitle>
                <DialogDescription>A modal dialog.</DialogDescription>
              </DialogHeader>
            </DialogContent>
          </Dialog>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline">Open alert dialog</Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Lab alert</AlertDialogTitle>
                <AlertDialogDescription>A modal alert dialog.</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction>Confirm</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="outline">Open sheet</Button>
            </SheetTrigger>
            <SheetContent>
              <SheetHeader>
                <SheetTitle>Lab sheet</SheetTitle>
                <SheetDescription>A sheet from the side.</SheetDescription>
              </SheetHeader>
            </SheetContent>
          </Sheet>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline">Open popover</Button>
            </PopoverTrigger>
            <PopoverContent>Lab popover</PopoverContent>
          </Popover>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline">Open menu</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem>First item</DropdownMenuItem>
              <DropdownMenuItem>Second item</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Select value={picked === "nothing" ? undefined : picked} onValueChange={setPicked}>
            <SelectTrigger aria-label="Fruit" className="w-40">
              <SelectValue placeholder="Pick a fruit" />
            </SelectTrigger>
            <SelectContent>
              {FRUITS.map((fruit) => (
                <SelectItem key={fruit} value={fruit}>
                  {fruit}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline">Hover for tooltip</Button>
            </TooltipTrigger>
            <TooltipContent>Lab tooltip</TooltipContent>
          </Tooltip>
          <Button variant="outline" onClick={() => setPaletteOpen(true)}>
            Open command palette
          </Button>
          <CommandPalette
            open={paletteOpen}
            onOpenChange={setPaletteOpen}
            groups={[{ heading: "Fruit", items: FRUITS.map((fruit) => ({ id: fruit, label: fruit, onSelect: () => setPicked(fruit) })) }]}
          />
        </div>
        <p className="text-sm text-muted-foreground">Picked: {picked}</p>
      </Section>
      <Section title="Scroll area">
        <ScrollArea aria-label="Scrolled lines" className="h-40 w-64 rounded-md border">
          <div className="p-3 text-sm">
            {LINES.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>
        </ScrollArea>
      </Section>
      <div aria-hidden="true" className="h-[200vh]" />
    </div>
  );
}
