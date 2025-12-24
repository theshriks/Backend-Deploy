import React from 'react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Button
interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
}
export const Button: React.FC<ButtonProps> = ({ className, variant = 'primary', size = 'md', ...props }) => {
  const variants = {
    primary: 'bg-white text-black hover:bg-neutral-200 border border-transparent',
    secondary: 'bg-neutral-900 text-neutral-300 border border-neutral-700 hover:border-neutral-500 hover:text-white',
    ghost: 'bg-transparent text-neutral-400 hover:text-white hover:bg-neutral-900',
    danger: 'bg-red-950/30 text-red-500 border border-red-900/50 hover:bg-red-950/50 hover:border-red-800'
  };
  const sizes = {
    sm: 'h-7 px-2 text-xs',
    md: 'h-9 px-4 text-sm',
    lg: 'h-11 px-6 text-base'
  };
  return (
    <button className={cn('inline-flex items-center justify-center rounded-md font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-neutral-700 disabled:opacity-50', variants[variant], sizes[size], className)} {...props} />
  );
};

// Input
export const Input: React.FC<React.InputHTMLAttributes<HTMLInputElement>> = ({ className, ...props }) => (
  <input className={cn('flex h-9 w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-1 text-sm text-neutral-100 shadow-sm transition-colors placeholder:text-neutral-600 focus:border-neutral-700 focus:outline-none focus:ring-1 focus:ring-neutral-700 disabled:cursor-not-allowed disabled:opacity-50', className)} {...props} />
);

// TextArea
export const TextArea: React.FC<React.TextareaHTMLAttributes<HTMLTextAreaElement>> = ({ className, ...props }) => (
  <textarea className={cn('flex w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 shadow-sm transition-colors placeholder:text-neutral-600 focus:border-neutral-700 focus:outline-none focus:ring-1 focus:ring-neutral-700 disabled:cursor-not-allowed disabled:opacity-50 font-mono', className)} {...props} />
);

// Card
export const Card: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({ className, ...props }) => (
  <div className={cn('rounded-lg border border-neutral-800 bg-neutral-950/50 text-neutral-100', className)} {...props} />
);

export const CardHeader: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({ className, ...props }) => (
  <div className={cn('flex flex-col space-y-1.5 p-6', className)} {...props} />
);

export const CardTitle: React.FC<React.HTMLAttributes<HTMLHeadingElement>> = ({ className, ...props }) => (
  <h3 className={cn('font-semibold leading-none tracking-tight text-neutral-100', className)} {...props} />
);

export const CardContent: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({ className, ...props }) => (
  <div className={cn('p-6 pt-0', className)} {...props} />
);

// Badge
export const Badge: React.FC<React.HTMLAttributes<HTMLDivElement> & { variant?: 'default' | 'outline' | 'success' | 'warning' }> = ({ className, variant = 'default', ...props }) => {
  const variants = {
    default: 'border-transparent bg-neutral-100 text-neutral-900',
    outline: 'border-neutral-700 text-neutral-400',
    success: 'border-transparent bg-green-950/50 text-green-400 border border-green-900/50',
    warning: 'border-transparent bg-yellow-950/50 text-yellow-400 border border-yellow-900/50'
  };
  return <div className={cn('inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-neutral-400 focus:ring-offset-2', variants[variant], className)} {...props} />;
};

// Modal (Simple overlay)
export const Modal: React.FC<{ isOpen: boolean; onClose: () => void; title: string; children: React.ReactNode }> = ({ isOpen, onClose, title, children }) => {
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-lg border border-neutral-800 bg-neutral-900 p-6 shadow-xl">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-white">{title}</h2>
          <button onClick={onClose} className="text-neutral-500 hover:text-white">✕</button>
        </div>
        <div>{children}</div>
      </div>
    </div>
  );
};