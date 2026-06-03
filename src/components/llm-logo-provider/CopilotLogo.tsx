const CopilotLogo = ({ className = 'w-5 h-5' }: { className?: string }) => {
  return (
    <img
      src="/icons/copilot.svg"
      alt="Copilot"
      className={className}
      onError={(e) => {
        // Fallback: hide broken image, parent shows text
        (e.target as HTMLImageElement).style.display = 'none';
      }}
    />
  );
};

export default CopilotLogo;
