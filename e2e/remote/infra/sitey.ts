export function wildDomainToSiteyUrl(wildCardDomain: string): string {
  return `https://sitey.${wildCardDomain.replace("*.", "")}`;
}
