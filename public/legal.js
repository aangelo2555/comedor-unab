fetch('/api/service-policy').then(async response => {
  if (!response.ok) throw new Error('Estado no disponible');
  const policy = await response.json();
  document.getElementById('legalOperator').textContent = policy.operator || 'Pendiente de configuración';
  const contact = document.getElementById('legalContact');
  if (policy.contact && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(policy.contact)) {
    contact.textContent = policy.contact;
    contact.href = 'mailto:' + policy.contact;
  }
  document.getElementById('legalReadiness').textContent = policy.ready
    ? 'El responsable debe verificar las obligaciones aplicables y mantener actualizada esta información.'
    : 'Pendiente de identificación y contacto del responsable. La integración y los aportes permanecen deshabilitados.';
}).catch(() => {
  document.getElementById('legalReadiness').textContent = 'No se pudo verificar el estado del proyecto. Consulta al responsable antes de utilizar la integración o realizar un aporte.';
});
