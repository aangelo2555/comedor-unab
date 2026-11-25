// A canceled ticket from an earlier attempt must not mask a new active request.
function requestView(request, tickets) {
  const related = tickets.filter(ticket => ticket.alumnoCodigo === request.alumnoCodigo &&
    ticket.fecha === request.fecha && ticket.tipoComida === request.tipoComida);
  const current = related.find(ticket => ['ACTIVA', 'CONSUMIDA'].includes(ticket.estado));
  const linked = related.find(ticket => ticket.id === request.ticketId);
  let status = request.status;
  if (status === 'ACTIVA') status = current?.estado === 'ACTIVA' ? 'CONFIRMADA' : current?.estado || status;
  else if (status === 'CONFIRMADA') {
    const ticketStatus = linked?.estado || current?.estado;
    status = ticketStatus === 'ACTIVA' ? 'CONFIRMADA' : ticketStatus || status;
  }
  return { id: request.id, meal: request.tipoComida, date: request.fecha, status };
}
module.exports = { requestView };
