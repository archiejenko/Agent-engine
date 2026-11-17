/** Pages that arrive later in v3 (Ideas and Board in Milestone D). */
export function Placeholder({ title, text }: { title: string; text: string }) {
  return (
    <>
      <h2>{title}</h2>
      <p className="empty">{text}</p>
    </>
  );
}
