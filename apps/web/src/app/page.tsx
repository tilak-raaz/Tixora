const STEPS = [
  { title: 'Pick a show', body: 'Choose a city, a movie and a time that suits you.' },
  { title: 'Choose your seats', body: 'Up to 5 seats, held for you for 5 minutes while you pay.' },
  { title: 'Pay and go', body: 'Your ticket, with a QR code, arrives by email and stays here.' },
];

export default function HomePage() {
  return (
    <div className="flex flex-col gap-8">
      <section className="relative overflow-hidden rounded-card bg-primary px-6 py-10 text-white sm:px-10 sm:py-14">
        <div
          aria-hidden
          className="absolute -top-16 -right-16 size-56 rounded-full bg-white/10 sm:size-72"
        />
        <div
          aria-hidden
          className="absolute -bottom-24 right-24 size-48 rounded-full bg-white/5 sm:size-64"
        />
        <div className="relative max-w-xl">
          <p className="text-sm font-semibold tracking-wide text-white/75 uppercase">
            Movie tickets
          </p>
          <h1 className="mt-2 font-display text-3xl leading-tight font-extrabold sm:text-5xl">
            The best seats go first. Get yours.
          </h1>
          <p className="mt-3 text-white/80 sm:text-lg">
            See which seats are free as it happens, and keep them while you pay.
          </p>
        </div>
      </section>

      <section aria-labelledby="how-it-works">
        <h2 id="how-it-works" className="font-display text-xl font-bold">
          How it works
        </h2>
        <ol className="mt-4 grid gap-3 sm:grid-cols-3">
          {STEPS.map((step, index) => (
            <li key={step.title} className="rounded-card bg-card p-5">
              <span className="flex size-8 items-center justify-center rounded-full bg-primary-soft font-display text-sm font-bold text-primary">
                {index + 1}
              </span>
              <h3 className="mt-3 font-semibold">{step.title}</h3>
              <p className="mt-1 text-sm text-muted">{step.body}</p>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
