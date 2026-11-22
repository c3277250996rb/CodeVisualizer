/* 折叠样例：then 分支里有 3 条语句（可折叠），else 分支只有 1 条（不可折叠）。 */
int fold_sample(int value) {
	int total = 0;
	if (value > 10) {
		total = value * 2;
		total += 1;
		MyUart_WriteString("big");
	} else {
		total = value;
	}
	return total;
}

/* then 分支里有提前 return，出口不唯一，属于不可折叠的区域。 */
int fold_multi_exit_sample(int value) {
	int total = 0;
	if (value > 10) {
		total = 1;
		if (value > 20) {
			return total;
		}
		total = 2;
	}
	return total;
}
