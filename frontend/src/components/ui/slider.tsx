import * as React from "react";
import * as SliderPrimitive from "@radix-ui/react-slider";
import { cn } from "@/lib/utils";

export const Slider = React.forwardRef<
  React.ElementRef<typeof SliderPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root> & { thumb?: boolean }
>(({ className, thumb = true, ...props }, ref) => (
  <SliderPrimitive.Root
    ref={ref}
    className={cn("group relative flex w-full touch-none select-none items-center py-2", className)}
    {...props}
  >
    <SliderPrimitive.Track className="relative h-1 w-full grow overflow-hidden rounded-full bg-white/20">
      <SliderPrimitive.Range className="absolute h-full bg-white group-hover:bg-primary" />
    </SliderPrimitive.Track>
    <SliderPrimitive.Thumb
      className={cn(
        "block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        !thumb && "scale-0 group-hover:scale-100 group-active:scale-100",
      )}
    />
  </SliderPrimitive.Root>
));
Slider.displayName = "Slider";
