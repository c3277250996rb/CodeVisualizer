/* 循环体展开专向样例：while 与 do-while 各占一个小区块，
 * 循环体里都放两条语句，用来验证循环体不是被压成一整块而是逐条成节点。 */
int while_body_sample(int seed) {
	int total = 0;
	int guard = 0;

	while (guard < seed) {
		total += guard;
		guard++;
	}

	return total;
}

int do_body_sample(int seed) {
	int total = seed;
	int guard = 0;

	do {
		total -= 2;
		guard++;
	} while (guard < 3);

	return total;
}
