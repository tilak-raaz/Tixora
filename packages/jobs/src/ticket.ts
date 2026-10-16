import { formatPaise } from '@bmt/shared';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { seatList, showTime, type BookingDetails } from './email-content';

/**
 * The ticket: one A6 page with the show, seats and a QR code. Rendered on
 * demand from the booking (for the confirmation email, and for downloading it
 * again), never stored, so it always matches the booking.
 *
 * The QR code carries the booking id. Checking tickets at the door is out of
 * scope; a scanner would look the booking up and check it is CONFIRMED.
 */

export function ticketReference(bookingId: string): string {
  return bookingId.slice(0, 8).toUpperCase();
}

export function ticketFilename(bookingId: string): string {
  return `ticket-${ticketReference(bookingId)}.pdf`;
}

export function ticketQrPayload(bookingId: string): string {
  return `BMT:${bookingId}`;
}

export async function renderTicketPdf(d: BookingDetails): Promise<Buffer> {
  const qr = await QRCode.toBuffer(ticketQrPayload(d.bookingId), {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 360,
  });

  const doc = new PDFDocument({
    size: 'A6',
    margin: 24,
    info: { Title: `Ticket ${ticketReference(d.bookingId)}`, Author: 'BookMyTicket' },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const width = doc.page.width - 48;
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#666').text('BOOKMYTICKET', { width });
  doc.moveDown(0.6);
  doc.font('Helvetica-Bold').fontSize(15).fillColor('#000').text(d.movieTitle, { width });
  doc.moveDown(0.3);
  doc.font('Helvetica').fontSize(9.5).text(showTime(d), { width });
  doc.text(`${d.theatreName}, ${d.screenName}`, { width });
  doc.fillColor('#666').text(d.theatreAddress, { width });
  doc.moveDown(0.6);
  doc
    .fillColor('#000')
    .font('Helvetica-Bold')
    .fontSize(11)
    .text(`Seats: ${seatList(d)}`, { width });
  // The standard PDF fonts have no rupee sign.
  doc
    .font('Helvetica')
    .fontSize(9.5)
    .text(`Paid: ${formatPaise(d.totalPaise).replace('₹', 'Rs. ')}`, {
      width,
    });

  const size = 150;
  const y = doc.y + 12;
  doc.image(qr, 24 + (width - size) / 2, y, { width: size, height: size });
  doc
    .font('Helvetica-Bold')
    .fontSize(12)
    .text(ticketReference(d.bookingId), 24, y + size + 6, { width, align: 'center' });
  doc
    .font('Helvetica')
    .fontSize(7.5)
    .fillColor('#666')
    .text(`Booked by ${d.userName}`, { width, align: 'center' });

  doc.end();
  return done;
}
