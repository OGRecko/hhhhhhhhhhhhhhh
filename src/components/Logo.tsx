import React from 'react';

export function Logo({ className, ...props }: React.ImgHTMLAttributes<HTMLImageElement>) {
  return (
    <img 
      src="/logo.png" 
      alt="Cavity Logo"
      className={className} 
      {...props}
    />
  );
}
