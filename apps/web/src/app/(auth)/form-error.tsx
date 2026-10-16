/** The message under a form when submitting fails; announced to screen readers. */
export function FormError({ message }: { message: string | null }) {
  return (
    <p role="alert" className="min-h-5 text-sm font-medium text-primary">
      {message}
    </p>
  );
}
